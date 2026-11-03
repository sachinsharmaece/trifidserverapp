import { MargBill } from '../../models/MargBill.js';
import { MargBillImport } from '../../models/MargBillImport.js';
import { So } from '../../models/So.js';
import { istMidnight, type Bill } from './holding.rules.js';

/**
 * LOCK-34 §4.2 — the bills of a party.
 *
 * A bill is a platform sales order whose Marg invoice MATCHED (a `query` bill
 * stops the chain and is not a bill), dated by the invoice date the keyer
 * typed. We read the Marg bill, not the order's current state, because a
 * billed order moves on to dispatched, delivered and closed.
 *
 * The value is the invoice total (it includes GST: it is matched to the order
 * total within ₹5). Refunds and returned boxes are NOT deducted yet (client,
 * 3 Nov 2026): a part-rejection refund is raised before billing, so the bill is
 * already net of it, and return notes carry no value until the accounting
 * module adds one. `returnedValuePaise` is the one place that will change.
 *
 * Historical bills from the Marg import also count — only those dated before
 * go-live, and only if the invoice number is not already a platform bill, so
 * nothing is counted twice.
 */
export function returnedValuePaise(): number {
  return 0;
}

/** The same invoice number written two ways (case, spaces) is one invoice. */
export function invoiceKey(invoiceNo: string): string {
  return invoiceNo.trim().toUpperCase();
}

export async function billsForMany(
  partyIds: readonly string[],
  goLiveDate: string | null,
): Promise<Map<string, Bill[]>> {
  const result = new Map<string, Bill[]>(partyIds.map((id) => [id, []]));
  if (partyIds.length === 0) return result;

  const orders = await So.find({ buyerId: { $in: partyIds } }, { buyerId: 1 }).lean();
  const partyOfOrder = new Map(orders.map((o) => [String(o._id), String(o.buyerId)]));
  const platform = partyOfOrder.size
    ? await MargBill.find({ soId: { $in: [...partyOfOrder.keys()] }, state: 'matched' }).lean()
    : [];

  const platformInvoices = new Map<string, Set<string>>();
  for (const bill of platform) {
    const party = partyOfOrder.get(String(bill.soId));
    if (!party) continue;
    result.get(party)!.push({
      date: bill.keyedAt,
      netPaise: bill.valuePaise - returnedValuePaise(),
      id: String(bill._id),
    });
    const seen = platformInvoices.get(party) ?? new Set<string>();
    seen.add(invoiceKey(bill.margInvoiceNo));
    platformInvoices.set(party, seen);
  }

  const imported = await MargBillImport.find({ partyId: { $in: partyIds } }).lean();
  const before = goLiveDate ? istMidnight(goLiveDate).getTime() : Number.POSITIVE_INFINITY;
  for (const row of imported) {
    const party = String(row.partyId);
    if (row.billDate.getTime() >= before) continue;
    if (platformInvoices.get(party)?.has(row.invoiceKey)) continue;
    result.get(party)?.push({ date: row.billDate, netPaise: row.netPaise, id: String(row._id) });
  }
  return result;
}

export async function billsFor(partyId: string, goLiveDate: string | null): Promise<Bill[]> {
  return (await billsForMany([partyId], goLiveDate)).get(partyId) ?? [];
}
