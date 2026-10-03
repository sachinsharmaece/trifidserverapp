import type { Types } from 'mongoose';
import { So } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { Po } from '../../models/Po.js';
import { PoLine } from '../../models/PoLine.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Tehsil } from '../../models/Tehsil.js';
import { SellerArea } from '../../models/SellerArea.js';
import { Bankbook } from '../../models/Bankbook.js';
import { UpcomingReceipt } from '../../models/UpcomingReceipt.js';
import { MargBill } from '../../models/MargBill.js';
import { SellerBill } from '../../models/SellerBill.js';
import { Inspection } from '../../models/Inspection.js';
import { ReceiptConfirmation } from '../../models/ReceiptConfirmation.js';
import { BankDetail } from '../../models/BankDetail.js';
import { Refund } from '../../models/Refund.js';
import { PaymentRun } from '../../models/PaymentRun.js';
import { Movement } from '../../models/Movement.js';
import { Chain } from '../../models/Chain.js';
import { ChainEvent } from '../../models/ChainEvent.js';
import { AuditLog } from '../../models/AuditLog.js';
import { Employee } from '../../models/Employee.js';
import { computeSellerLineMoney } from '../../shared/pricing.js';
import { decryptAccountNumber } from '../../shared/encryption.js';
import { isBankDetailPayable } from '../onboarding/onboarding.service.js';
import type {
  AccountsBankChange,
  AccountsBankLine,
  AccountsLogEntry,
  AccountsMargBill,
  AccountsMovement,
  AccountsParty,
  AccountsPo,
  AccountsRefund,
  AccountsRepost,
  AccountsRun,
  AccountsSellerBill,
  AccountsSnapshot,
  AccountsSo,
  AccountsSoState,
  AccountsUpcoming,
} from './accounts.types.js';

/**
 * Pre-launch bound, not a design: the snapshot carries the newest orders and
 * everything hanging off them. When volume makes this too heavy the views
 * split into their own paged endpoints (see the Accounts plan, phase 2b).
 */
const SO_LIMIT = 1000;
const GST_PCT = 18; // Q3a — GROSS_NUMERATOR 118 in shared/pricing.ts.

const key = (value: unknown): string => String(value);

/** IST wall-clock, "YYYY-MM-DD HH:mm" — the desk is run in India. */
function istStamp(date: Date): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16);
}
const istDay = (date: Date): string => istStamp(date).slice(0, 10);

const shortId = (id: unknown): string => key(id).slice(-6).toUpperCase();

function maskedAccount(encrypted: string | null | undefined): string {
  if (!encrypted) return '—';
  try {
    return `···${decryptAccountNumber(encrypted).slice(-4)}`;
  } catch {
    return '···';
  }
}

function maskMobile(mobile: string | undefined): string {
  if (!mobile) return '—';
  const digits = mobile.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5, 7)}xxx` : '—';
}

const MODE_LABEL: Record<string, string> = {
  bank_message: 'Bank message',
  utr: 'UTR',
  screenshot: 'Screenshot',
};

const REFUND_WHY: Record<string, string> = {
  supply_failure_full: 'Supply failed — the seller did not deliver and no alternative was found',
  part_rejection_quantity_reduction: 'Part of the goods were rejected — quantity reduced',
  payment_window_expired: 'Paid after the payment window had closed',
  buyer_silence_on_ghosting: 'The buyer went silent after the order was raised',
};

function soStateOf(so: { state: string }, hasQuery: boolean): AccountsSoState {
  switch (so.state) {
    case 'awaiting_payment':
    case 'payment_verifying':
    case 'draft':
    case 'awaiting_seller_confirmation':
    case 'requote_offered':
      return 'awaiting_payment';
    case 'po_released':
    case 'dispatched_leg1':
    case 'at_indore':
      return 'awaiting_goods';
    case 'inspected':
      return hasQuery ? 'billing_query' : 'ready_to_bill';
    case 'billed_in_marg':
      return 'awaiting_dispatch';
    case 'supply_failed':
      return 'supply_failed';
    case 'promotion_offered':
      return 'promotion_offered';
    case 'disputed':
      return 'disputed';
    default:
      return 'closed'; // dispatched_leg2, delivered, closed
  }
}

type Lean<T> = T & { _id: Types.ObjectId; createdAt: Date };

export async function buildAccountsSnapshot(now: Date = new Date()): Promise<AccountsSnapshot> {
  const sos = (await So.find({ state: { $ne: 'cancelled' } })
    .sort({ createdAt: -1 })
    .limit(SO_LIMIT)
    .lean()) as unknown as Array<Lean<typeof So.prototype>>;
  const soIds = sos.map((s) => s._id);
  const chainIds = sos.map((s) => s.chainId);

  const [
    soLines,
    pos,
    chains,
    buyers,
    sellers,
    bankbook,
    upcoming,
    margBills,
    sellerBills,
    refunds,
    runs,
    employees,
    bankDetails,
    events,
    movements,
    repostAudits,
  ] = await Promise.all([
    SoLine.find({ soId: { $in: soIds } }).lean(),
    Po.find({ soId: { $in: soIds } }).lean(),
    Chain.find({ _id: { $in: chainIds } }).lean(),
    Buyer.find({}).lean(),
    Seller.find({}).lean(),
    Bankbook.find({}).sort({ date: 1, createdAt: 1 }).lean(),
    UpcomingReceipt.find({ state: { $ne: 'cleared' } })
      .sort({ claimedAt: -1 })
      .lean(),
    MargBill.find({ soId: { $in: soIds } })
      .sort({ keyedAt: 1 })
      .lean(),
    SellerBill.find({ booked: true }).lean(),
    Refund.find({ state: { $ne: 'released' } }).lean(),
    PaymentRun.find({}).sort({ createdAt: -1 }).limit(50).lean(),
    Employee.find({}).select('person').lean(),
    BankDetail.find({}).sort({ createdAt: -1 }).lean(),
    ChainEvent.find({ chainId: { $in: chainIds } })
      .sort({ at: 1 })
      .lean(),
    Movement.find({ chainId: { $in: chainIds } }).lean(),
    AuditLog.find({ entity: 'bankbook', field: 'reverse_and_repost' }).lean(),
  ]);

  const poIds = pos.map((p) => p._id);
  const [poLines, inspections, confirmations] = await Promise.all([
    PoLine.find({ poId: { $in: poIds } }).lean(),
    Inspection.find({ poId: { $in: poIds } }).lean(),
    ReceiptConfirmation.find({ poId: { $in: poIds } }).lean(),
  ]);

  const skuIds = [...soLines.map((l) => l.skuId), ...poLines.map((l) => l.skuId)];
  const skus = await Sku.find({ _id: { $in: skuIds } }).lean();
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } }).lean();
  const counterpartyIds = [...buyers, ...sellers].map((p) => p.counterpartyId);
  const [counterparties, tehsils, sellerAreas] = await Promise.all([
    Counterparty.find({ _id: { $in: counterpartyIds }, status: 'active' }).lean(),
    Tehsil.find({}).lean(),
    SellerArea.find({}).lean(),
  ]);

  const employeeName = new Map(employees.map((e) => [key(e._id), e.person]));
  const who = (id: unknown): string => employeeName.get(key(id)) ?? 'Staff';
  const productOf = new Map(products.map((p) => [key(p._id), p]));
  const skuOf = new Map(skus.map((s) => [key(s._id), s]));
  const itemName = (skuId: unknown): string => {
    const sku = skuOf.get(key(skuId));
    const product = sku ? productOf.get(key(sku.productId)) : undefined;
    return sku && product ? `${product.brand} ${sku.packLabel}` : 'Item';
  };
  const soById = new Map(sos.map((s) => [key(s._id), s]));
  const soNoOf = (id: unknown): string | null => soById.get(key(id))?.soNo ?? null;
  const chainNo = new Map(chains.map((c) => [key(c._id), c.chainNo]));
  const poById = new Map(pos.map((p) => [key(p._id), p]));
  const poBySo = new Map(pos.map((p) => [key(p.soId), p]));

  // --- parties ---------------------------------------------------------
  const counterpartyOf = new Map(counterparties.map((c) => [key(c._id), c]));
  const tehsilName = new Map(tehsils.map((t) => [key(t._id), t.name]));
  const latestDetail = new Map<string, (typeof bankDetails)[number]>();
  const detailsOf = new Map<string, Array<(typeof bankDetails)[number]>>();
  for (const detail of bankDetails) {
    const k = key(detail.counterpartyId);
    if (!latestDetail.has(k)) latestDetail.set(k, detail);
    detailsOf.set(k, [...(detailsOf.get(k) ?? []), detail]);
  }
  const bankPayable = (counterpartyId: unknown): boolean => {
    const detail = latestDetail.get(key(counterpartyId));
    return (
      !!detail &&
      isBankDetailPayable({
        verifiedAt: detail.verifiedAt ?? null,
        effectiveFrom: detail.effectiveFrom ?? null,
      })
    );
  };
  const activeDetail = (counterpartyId: unknown) =>
    (detailsOf.get(key(counterpartyId)) ?? []).find(
      (d) => d.verifiedAt && d.effectiveFrom && d.effectiveFrom.getTime() <= now.getTime(),
    );

  const parties: AccountsParty[] = [];
  const partyName = new Map<string, string>();
  for (const buyer of buyers) {
    const cp = counterpartyOf.get(key(buyer.counterpartyId));
    if (!cp) continue;
    const name = cp.firm ?? cp.ownerName ?? 'Buyer';
    partyName.set(key(buyer._id), name);
    parties.push({
      id: key(buyer._id),
      type: 'buyer',
      name,
      person: cp.ownerName ?? '',
      area: buyer.tehsilId ? (tehsilName.get(key(buyer.tehsilId)) ?? '') : '',
      gstin: cp.gstin ?? '—',
      bank: maskedAccount(activeDetail(buyer.counterpartyId)?.accountEncrypted),
      mobile: maskMobile(cp.mobile),
      openingPaise: buyer.openingBalancePaise,
      since: istDay(cp.createdAt as Date),
    });
  }
  for (const seller of sellers) {
    const cp = counterpartyOf.get(key(seller.counterpartyId));
    if (!cp) continue;
    const name = cp.firm ?? cp.ownerName ?? 'Seller';
    partyName.set(key(seller._id), name);
    const area = sellerAreas.find((a) => key(a.sellerId) === key(seller._id));
    parties.push({
      id: key(seller._id),
      type: 'seller',
      name,
      person: cp.ownerName ?? '',
      area: area ? (tehsilName.get(key(area.tehsilId)) ?? '') : '',
      gstin: cp.gstin ?? '—',
      bank: maskedAccount(activeDetail(seller.counterpartyId)?.accountEncrypted),
      mobile: maskMobile(cp.mobile),
      openingPaise: seller.openingBalancePaise,
      since: istDay(cp.createdAt as Date),
      verified: bankPayable(seller.counterpartyId),
    });
  }
  const name = (id: unknown): string => partyName.get(key(id)) ?? 'Unknown';

  // --- the log every document shows ------------------------------------
  const logOf = new Map<string, AccountsLogEntry[]>();
  for (const event of events) {
    const entry: AccountsLogEntry = {
      at: istStamp(event.at),
      by:
        event.actorType === 'staff'
          ? who(event.actorId)
          : event.actorType === 'system'
            ? 'System'
            : 'Counterparty',
      what: event.summary,
      why: event.reason ?? '',
    };
    const k = key(event.chainId);
    logOf.set(k, [...(logOf.get(k) ?? []), entry]);
  }
  const logFor = (chainId: unknown): AccountsLogEntry[] => logOf.get(key(chainId)) ?? [];

  // --- marg ------------------------------------------------------------
  const queryBySo = new Set(margBills.filter((m) => m.state === 'query').map((m) => key(m.soId)));
  const matchedBySo = new Set(
    margBills.filter((m) => m.state === 'matched').map((m) => key(m.soId)),
  );
  const outMarg: AccountsMargBill[] = margBills.map((m) => {
    const so = soById.get(key(m.soId));
    const gap = so ? m.valuePaise - so.totalPaise : 0;
    return {
      id: m.margInvoiceNo,
      so: so?.soNo ?? '',
      party: so ? key(so.buyerId) : '',
      date: istDay(m.keyedAt),
      by: who(m.keyedBy),
      valuePaise: m.valuePaise,
      eway: m.ewayNo,
      state: m.state,
      note:
        m.state === 'query'
          ? `₹${(Math.abs(gap) / 100).toLocaleString('en-IN')} ${gap < 0 ? 'below' : 'above'} the SO. Correct it in Marg and re-key it here.`
          : null,
    };
  });

  // --- orders ----------------------------------------------------------
  const soLineOf = new Map(soLines.map((l) => [key(l.soId), l]));
  const outSos: AccountsSo[] = sos.map((so) => {
    const line = soLineOf.get(key(so._id));
    const po = poBySo.get(key(so._id));
    const state = soStateOf(so, queryBySo.has(key(so._id)) && !matchedBySo.has(key(so._id)));
    const leftH =
      state === 'awaiting_payment'
        ? Math.max(0, Math.ceil((so.payDeadline.getTime() - now.getTime()) / 3_600_000))
        : 0;
    const taxable = line?.taxablePaise ?? 0;
    return {
      id: so.soNo,
      key: key(so._id),
      chain: chainNo.get(key(so.chainId)) ?? '',
      party: key(so.buyerId),
      date: istDay(so.createdAt),
      leftH,
      state,
      lines: line
        ? [
            {
              item: itemName(line.skuId),
              qty: line.boxes,
              ratePaise: line.ratePaise * line.baseUnitsPerBoxAtOrder,
              baseUnitsPerBox: line.baseUnitsPerBoxAtOrder,
            },
          ]
        : [],
      taxablePaise: taxable,
      gstPaise: so.totalPaise - taxable,
      totalPaise: so.totalPaise,
      po: po?.poNo ?? null,
      log: logFor(so.chainId),
    };
  });

  const inspectionOf = new Map(inspections.map((i) => [key(i.poId), i]));
  const confirmationOf = new Map(confirmations.map((c) => [key(c.poId), c]));
  const billOf = new Map(sellerBills.map((b) => [key(b.poId), b]));
  const poLineOf = new Map(poLines.map((l) => [key(l.poId), l]));
  const sellerCounterparty = new Map(sellers.map((s) => [key(s._id), s.counterpartyId]));

  const outPos: AccountsPo[] = pos.map((po) => {
    const so = soById.get(key(po.soId));
    const line = poLineOf.get(key(po._id));
    const sku = line ? skuOf.get(key(line.skuId)) : undefined;
    const money =
      line && sku
        ? computeSellerLineMoney(
            line.boxes,
            sku.baseUnitsPerBox,
            line.sellerNetPaise,
            (so?.placeOfSupply ?? 'intra_state') as 'intra_state' | 'inter_state',
          )
        : { taxablePaise: 0, totalPaise: 0 };
    const bill = billOf.get(key(po._id));
    const confirmation = confirmationOf.get(key(po._id));
    return {
      id: po.poNo,
      key: key(po._id),
      chain: chainNo.get(key(po.chainId)) ?? '',
      party: key(po.sellerId),
      so: so?.soNo ?? '',
      date: istDay(po.createdAt),
      due: istDay(po.dispatchDueDate),
      lines:
        line && sku
          ? [
              {
                item: itemName(line.skuId),
                qty: line.boxes,
                ratePaise: line.sellerNetPaise * sku.baseUnitsPerBox,
                baseUnitsPerBox: sku.baseUnitsPerBox,
              },
            ]
          : [],
      taxablePaise: money.taxablePaise,
      gstPaise: money.totalPaise - money.taxablePaise,
      totalPaise: money.totalPaise,
      payablePaise: bill ? bill.acceptedValuePaise : money.totalPaise,
      received: po.received,
      inspected: !!inspectionOf.get(key(po._id))?.signedAt,
      billed: !!bill,
      confirmed: !!(confirmation?.productMatches && confirmation?.qtyMatches),
      bankOk: bankPayable(sellerCounterparty.get(key(po.sellerId))),
      hold: po.hold,
      paid: po.paid,
      failed: po.failed,
      log: logFor(po.chainId),
    };
  });

  const outBills: AccountsSellerBill[] = sellerBills.map((b) => ({
    id: b.billNo,
    po: poById.get(key(b.poId))?.poNo ?? '',
    party: key(b.sellerId),
    date: istDay(b.date),
    taxablePaise: b.taxablePaise,
    gstPaise: b.totalPaise - b.taxablePaise,
    totalPaise: b.totalPaise,
    filed: b.filed,
    key: key(b._id),
  }));

  // --- money in the building ------------------------------------------
  const outUpcoming: AccountsUpcoming[] = upcoming.map((u) => {
    const soNos = (u.soIds ?? []).map((id) => soNoOf(id)).filter((n): n is string => !!n);
    const state = u.state === 'landed_wrong_account' ? 'landed_wrong_account' : 'waiting';
    return {
      id: `UR-${shortId(u._id)}`,
      key: key(u._id),
      party: key(u.buyerId),
      saidAt: istStamp(u.claimedAt),
      amountPaise: u.amountPaise,
      utr: u.utr ?? '—',
      mode: MODE_LABEL[u.method] ?? u.method,
      sos: soNos,
      pickedBy: u.pickedBy ? who(u.pickedBy) : '—',
      state,
      note:
        state === 'landed_wrong_account'
          ? 'The money is here — but from an account that is not the one on file. Sales must confirm it is his before it is posted.'
          : soNos.length
            ? 'Not in the account yet.'
            : 'Sales has not yet picked which orders this covers.',
    };
  });

  const runItemRef = new Map<string, string>();
  for (const run of runs) {
    for (const item of run.items) {
      runItemRef.set(
        `${key(run._id)}:${key(item.refId)}`,
        item.kind === 'payout'
          ? (poById.get(key(item.refId))?.poNo ?? 'PO')
          : `RF-${shortId(item.refId)}`,
      );
    }
  }
  const repostFor = new Map(repostAudits.map((a) => [key(a.entityId), a]));
  const bankKeyToId = new Map<string, string>();
  const outBank: AccountsBankLine[] = bankbook.map((b) => {
    const id = `${b.kind === 'in' ? 'BR' : 'BP'}-${shortId(b._id)}`;
    bankKeyToId.set(key(b._id), id);
    const soNos = (b.soIds ?? []).map((s) => soNoOf(s)).filter((n): n is string => !!n);
    const ref =
      b.kind === 'in'
        ? (soNos[0] ?? null)
        : b.ref
          ? (runItemRef.get(`${b.ref}:${key(b.partyId)}`) ?? null)
          : null;
    return {
      id,
      key: key(b._id),
      date: istDay(b.date),
      kind: b.kind,
      purpose: b.purpose,
      party: key(b.partyId),
      partyType: b.partyType,
      ref,
      amountPaise: b.amountPaise,
      utr: b.utr ?? '—',
      from: b.kind === 'in' ? maskedAccount(b.remitterAccountEncrypted) : '',
      narration: b.narration ?? '',
      queried: b.queried,
    };
  });
  // A payout line's ref is the run id; resolve it to the PO the line paid.
  for (const line of outBank) {
    if (line.kind !== 'out' || line.ref) continue;
    const raw = bankbook.find((b) => key(b._id) === line.key);
    if (!raw?.ref) continue;
    const run = runs.find((r) => key(r._id) === raw.ref);
    const item = run?.items.find(
      (i) => key(i.partyId) === line.party && i.amountPaise === line.amountPaise,
    );
    if (item && run) line.ref = runItemRef.get(`${key(run._id)}:${key(item.refId)}`) ?? null;
  }

  const outReposts: AccountsRepost[] = bankbook
    .filter((b) => b.purpose === 'reversal' && b.reversalOf)
    .map((b) => {
      const audit = repostFor.get(key(b.reversalOf));
      const corrected = audit?.newValue as { correctedId?: unknown } | undefined;
      const to = corrected?.correctedId
        ? bankbook.find((x) => key(x._id) === key(corrected.correctedId))
        : undefined;
      return {
        at: istStamp(b.createdAt as Date),
        by: who(b.postedBy),
        line: bankKeyToId.get(key(b.reversalOf)) ?? '',
        from: key(b.partyId),
        to: to ? key(to.partyId) : key(b.partyId),
        why: audit?.reason ?? b.narration ?? '',
      };
    });

  const chainSoNo = new Map(sos.map((s) => [key(s.chainId), s.soNo]));
  const outRefunds: AccountsRefund[] = refunds.map((r) => ({
    id: `RF-${shortId(r._id)}`,
    key: key(r._id),
    party: key(r.buyerId),
    so: chainSoNo.get(key(r.chainId)) ?? null,
    amountPaise: r.amountPaise,
    state:
      r.state === 'payable'
        ? 'ready'
        : r.state === 'held_mismatch'
          ? 'held'
          : r.state === 'in_batch'
            ? 'in_batch'
            : 'not_payable',
    why: REFUND_WHY[r.reasonCode] ?? r.reasonCode,
  }));

  const outRuns: AccountsRun[] = runs.map((run) => ({
    id: `RUN-${shortId(run._id)}`,
    key: key(run._id),
    builtBy: who(run.builtBy),
    builtByKey: key(run.builtBy),
    builtAt: istStamp(run.createdAt as Date),
    state:
      run.state === 'released'
        ? 'released'
        : run.state === 'sent_back'
          ? 'sent_back'
          : 'awaiting_release',
    releasedBy: run.releasedBy ? who(run.releasedBy) : null,
    releasedAt: run.releasedAt ? istStamp(run.releasedAt) : null,
    sentBackBy: run.sentBackBy ? who(run.sentBackBy) : null,
    sentBackAt: run.sentBackAt ? istStamp(run.sentBackAt) : null,
    sentBackReason: run.sentBackReason ?? null,
    items: run.items.map((item) => ({
      kind: item.kind,
      key: key(item.refId),
      ref: runItemRef.get(`${key(run._id)}:${key(item.refId)}`) ?? '',
      party: key(item.partyId),
      amountPaise: item.amountPaise,
    })),
  }));

  // A bank-account change is a newer BankDetail than the one now in force,
  // not yet payable (BR-017): either no call-back yet, or still cooling.
  const counterpartyToParty = new Map<string, string>();
  for (const b of buyers) counterpartyToParty.set(key(b.counterpartyId), key(b._id));
  for (const s of sellers) counterpartyToParty.set(key(s.counterpartyId), key(s._id));
  const outChanges: AccountsBankChange[] = [];
  for (const [cpId, list] of detailsOf) {
    const [newest] = list;
    const partyId = counterpartyToParty.get(cpId);
    if (!newest || !partyId || list.length < 2) continue;
    if (bankPayable(cpId)) continue;
    const current = activeDetail(cpId);
    outChanges.push({
      id: `BC-${shortId(newest._id)}`,
      key: key(newest._id),
      party: partyId,
      old: maskedAccount(current?.accountEncrypted),
      new: maskedAccount(newest.accountEncrypted),
      asked: istStamp(newest.createdAt as Date),
      callback: !!newest.callbackLoggedAt,
      effectiveFrom: newest.effectiveFrom ? istStamp(newest.effectiveFrom) : null,
    });
  }

  // --- goods movement — what Accounts needs and no more ------------------
  const outMoves: AccountsMovement[] = [];
  for (const m of movements) {
    const so = sos.find((s) => key(s.chainId) === key(m.chainId));
    const po = pos.find((p) => key(p.chainId) === key(m.chainId));
    if (!so || !po) continue;
    const line = soLineOf.get(key(so._id));
    const what = line ? `${itemName(line.skuId)} · ${line.boxes} boxes` : '—';
    if (m.leg === 1) {
      outMoves.push({
        id: `MV-${shortId(m._id)}`,
        leg: 1,
        chain: chainNo.get(key(m.chainId)) ?? '',
        ref: po.poNo,
        what,
        counter: name(po.sellerId),
        lr: m.lr ?? '—',
        left: istDay(m.dispatchedAt),
        due: istDay(po.dispatchDueDate),
        state: po.received ? 'at_indore' : 'in_transit',
      });
    } else {
      outMoves.push({
        id: `MV-${shortId(m._id)}`,
        leg: 2,
        chain: chainNo.get(key(m.chainId)) ?? '',
        ref: so.soNo,
        what,
        counter: name(so.buyerId),
        lr: m.lr ?? '—',
        left: istDay(m.dispatchedAt),
        due: so.deliveryWindowEndsAt ? istDay(so.deliveryWindowEndsAt) : null,
        state: ['delivered', 'closed'].includes(so.state) ? 'delivered' : 'in_transit',
      });
    }
  }
  // Leg-1 goods that were not dispatched through a Movement but are in the yard
  // never appear above; leg-2 consignments Accounts is holding are synthesised.
  for (const so of sos) {
    const state = soStateOf(so, queryBySo.has(key(so._id)) && !matchedBySo.has(key(so._id)));
    if (!['ready_to_bill', 'billing_query', 'awaiting_dispatch'].includes(state)) continue;
    const line = soLineOf.get(key(so._id));
    outMoves.push({
      id: `MV-${shortId(so._id)}`,
      leg: 2,
      chain: chainNo.get(key(so.chainId)) ?? '',
      ref: so.soNo,
      what: line ? `${itemName(line.skuId)} · ${line.boxes} boxes` : '—',
      counter: name(so.buyerId),
      lr: '—',
      left: null,
      due: null,
      state: 'held',
      note:
        state === 'billing_query'
          ? 'Marg value is under query. Nothing moves on a disputed invoice.'
          : state === 'ready_to_bill'
            ? 'Not billed in Marg. No invoice, no e-way bill, no movement.'
            : 'Billed in Marg. Waiting for Logistics to dispatch.',
    });
  }

  const bankClosingPaise = bankbook.reduce(
    (total, b) => total + (b.kind === 'in' ? b.amountPaise : -b.amountPaise),
    0,
  );

  return {
    today: istDay(now),
    day: now.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
    period: now.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'long',
      year: 'numeric',
    }),
    config: { gstPct: GST_PCT, payWindowH: 24, sellerLockH: 24, callbackCoolingH: 24 },
    bankClosingPaise,
    parties,
    sos: outSos,
    pos: outPos,
    bills: outBills,
    margBills: outMarg,
    upcoming: outUpcoming,
    bankbook: outBank,
    reposts: outReposts,
    refunds: outRefunds,
    runs: outRuns,
    bankChanges: outChanges,
    movements: outMoves,
  };
}
