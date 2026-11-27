import {
  BuyerModel,
  ComplaintModel,
  InspectionModel,
  JobRunModel,
  LedgerModel,
  PayoutBatchModel,
  PurchaseOrderModel,
  ReceiptModel,
  SalesOrderModel,
  SellerModel,
  TradeModel,
  VoucherModel,
} from '../../models/index.js';
import { MAX_STORED_FINDINGS } from '../../models/jobRun.model.js';
import type { Types } from 'mongoose';
import type { IntegrityCheck, JobTrigger } from '../../shared/enums.js';
import { formatRupees } from '../../shared/money.js';
import { logger } from '../../shared/logger.js';
import { istDate } from '../payments/payments.js';

/**
 * The integrity check (ARCH §3.8 and §4.6, SRS-NFR-08). Once a night, and whenever a supervisor presses "Run now",
 * it reads the data and looks for things that must never be true. It only READS: it never fixes anything. A
 * finding names the record, and a person decides what to do. The goal is zero findings (SRS-NFR-08).
 *
 * Four groups of checks:
 *   ORPHAN_REFERENCE  a record points at another record that does not exist
 *   TOTAL_MISMATCH    a total is not the sum of its parts (order lines, GST parts, voucher sides, money received)
 *   TRIAL_BALANCE     the debits of all vouchers do not equal the credits
 *   VOUCHER_SOURCE    a voucher with no document behind it, or a document that should have a voucher and has none
 *
 * Each run is saved in `job_runs`, so the Integrity page can show when it last ran and what it found.
 */

export interface Finding {
  check: IntegrityCheck;
  ref: string;
  message: string;
}

const find = (check: IntegrityCheck, ref: string, message: string): Finding => ({
  check,
  ref,
  message,
});

const key = (id: unknown) => String(id);

/** Looks the ids up in one collection and answers with the ones found (`{ _id }` rows). */
type Finder = (ids: string[]) => PromiseLike<{ _id: unknown }[]>;

/** The ids from `ids` that exist in the collection that `finder` reads. */
async function presentIds(finder: Finder, ids: unknown[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean).map(key))];
  if (unique.length === 0) return new Set();
  return new Set((await finder(unique)).map((doc) => key(doc._id)));
}

interface Pointer {
  from: string;
  field: string;
  to: string;
  id: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Check 1: orphan references

async function orphans(data: Data): Promise<Finding[]> {
  const pointers: Pointer[] = [
    ...data.orders.flatMap((order) => [
      { from: order.number, field: 'buyer', to: 'buyers', id: order.buyerId },
      { from: order.number, field: 'seller', to: 'sellers', id: order.sellerId },
      { from: order.number, field: 'trade', to: 'trades', id: order.tradeId },
    ]),
    ...data.purchaseOrders.flatMap((po) => [
      { from: po.number, field: 'sales order', to: 'sales_orders', id: po.salesOrderId },
      { from: po.number, field: 'seller', to: 'sellers', id: po.sellerId },
      { from: po.number, field: 'trade', to: 'trades', id: po.tradeId },
    ]),
    ...data.receipts.flatMap((receipt) => [
      { from: receipt.number, field: 'sales order', to: 'sales_orders', id: receipt.salesOrderId },
      { from: receipt.number, field: 'buyer', to: 'buyers', id: receipt.buyerId },
      { from: receipt.number, field: 'bank ledger', to: 'ledgers', id: receipt.bankLedgerId },
    ]),
    ...data.trades
      .filter((trade) => trade.salesOrderId)
      .map((trade) => ({
        from: trade.number,
        field: 'sales order',
        to: 'sales_orders',
        id: trade.salesOrderId,
      })),
    ...data.vouchers.flatMap((voucher) =>
      voucher.lines.map((line) => ({
        from: voucher.number,
        field: 'ledger',
        to: 'ledgers',
        id: line.ledgerId,
      })),
    ),
  ];
  const finders: Record<string, Finder> = {
    buyers: (ids) => BuyerModel.find({ _id: { $in: ids } }, { _id: 1 }),
    sellers: (ids) => SellerModel.find({ _id: { $in: ids } }, { _id: 1 }),
    trades: (ids) => TradeModel.find({ _id: { $in: ids } }, { _id: 1 }),
    sales_orders: (ids) => SalesOrderModel.find({ _id: { $in: ids } }, { _id: 1 }),
    ledgers: (ids) => LedgerModel.find({ _id: { $in: ids } }, { _id: 1 }),
  };
  const findings: Finding[] = [];
  for (const [name, finder] of Object.entries(finders)) {
    const wanted = pointers.filter((pointer) => pointer.to === name);
    const present = await presentIds(
      finder,
      wanted.map((pointer) => pointer.id),
    );
    for (const pointer of wanted) {
      if (!present.has(key(pointer.id))) {
        findings.push(
          find(
            'ORPHAN_REFERENCE',
            pointer.from,
            `${pointer.from} points at a ${pointer.field} that does not exist.`,
          ),
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// Check 2: totals

function totals(data: Data): Finding[] {
  const findings: Finding[] = [];
  const postedByOrder = new Map<string, number>();
  for (const receipt of data.receipts.filter((item) => item.status === 'POSTED')) {
    const id = key(receipt.salesOrderId);
    postedByOrder.set(id, (postedByOrder.get(id) ?? 0) + receipt.amountPaise);
  }

  for (const order of data.orders) {
    const lines = order.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (lines !== order.totalPaise) {
      findings.push(
        find(
          'TOTAL_MISMATCH',
          order.number,
          `The order total is ${formatRupees(order.totalPaise)} but its lines add up to ${formatRupees(lines)}.`,
        ),
      );
    }
    for (const line of order.lines) {
      if (line.boxValuePaise * line.boxes !== line.lineTotalPaise) {
        findings.push(
          find(
            'TOTAL_MISMATCH',
            order.number,
            `Line ${line.lineNo}: box value × boxes is not the line total.`,
          ),
        );
      }
    }
    const gst = order.gst;
    const parts = gst.taxablePaise + gst.cgstPaise + gst.sgstPaise + gst.igstPaise;
    if (parts !== order.totalPaise) {
      findings.push(
        find(
          'TOTAL_MISMATCH',
          order.number,
          `The GST parts add up to ${formatRupees(parts)}, not the order total ${formatRupees(order.totalPaise)}.`,
        ),
      );
    }
    const received = postedByOrder.get(key(order._id)) ?? 0;
    if (received !== order.paidPaise) {
      findings.push(
        find(
          'TOTAL_MISMATCH',
          order.number,
          `The order says ${formatRupees(order.paidPaise)} is paid but confirmed receipts add up to ${formatRupees(received)}.`,
        ),
      );
    }
  }

  for (const po of data.purchaseOrders) {
    const lines = po.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (lines !== po.totalPaise) {
      findings.push(
        find(
          'TOTAL_MISMATCH',
          po.number,
          `The PO total is ${formatRupees(po.totalPaise)} but its lines add up to ${formatRupees(lines)}.`,
        ),
      );
    }
  }

  for (const voucher of data.vouchers) {
    const dr = voucher.lines.reduce((sum, line) => sum + line.drPaise, 0);
    const cr = voucher.lines.reduce((sum, line) => sum + line.crPaise, 0);
    if (dr !== cr || dr !== voucher.totalPaise) {
      findings.push(
        find(
          'TOTAL_MISMATCH',
          voucher.number,
          `Debits ${formatRupees(dr)}, credits ${formatRupees(cr)} and the voucher total ${formatRupees(voucher.totalPaise)} must all be equal.`,
        ),
      );
    }
    if (voucher.gst) {
      const { taxablePaise, cgstPaise, sgstPaise, igstPaise } = voucher.gst;
      if (taxablePaise + cgstPaise + sgstPaise + igstPaise !== voucher.totalPaise) {
        findings.push(
          find(
            'TOTAL_MISMATCH',
            voucher.number,
            'The taxable value plus the GST is not the voucher total.',
          ),
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// Check 3: the trial balance

function trialBalance(data: Data): Finding[] {
  let dr = 0;
  let cr = 0;
  for (const voucher of data.vouchers) {
    for (const line of voucher.lines) {
      dr += line.drPaise;
      cr += line.crPaise;
    }
  }
  if (dr === cr) return [];
  return [
    find(
      'TRIAL_BALANCE',
      'Trial balance',
      `All debits are ${formatRupees(dr)} and all credits are ${formatRupees(cr)}: they differ by ${formatRupees(Math.abs(dr - cr))}.`,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Check 4: every voucher has its document, and every document that needs a voucher has one

/** The voucher type each automatic posting must have. */
const VOUCHER_TYPE_OF_SOURCE = {
  RECEIPT: 'RECEIPT',
  MARG_BILL: 'SALES',
  INSPECTION: 'PURCHASE',
  PAYOUT_LINE: 'PAYMENT',
  COMPLAINT: 'JOURNAL',
} as const;

async function voucherSources(data: Data): Promise<Finding[]> {
  const findings: Finding[] = [];
  const vouchers = data.vouchers;
  const bySource = (type: string, id: unknown) =>
    vouchers.find((voucher) => voucher.source.type === type && key(voucher.source.id) === key(id));

  // Document → voucher
  for (const receipt of data.receipts.filter((item) => item.status === 'POSTED')) {
    const voucher = bySource('RECEIPT', receipt._id);
    if (!voucher) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          receipt.number,
          'The receipt is confirmed but has no RECEIPT voucher.',
        ),
      );
    } else if (voucher.totalPaise !== receipt.amountPaise) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          receipt.number,
          `The receipt is ${formatRupees(receipt.amountPaise)} but voucher ${voucher.number} is ${formatRupees(voucher.totalPaise)}.`,
        ),
      );
    }
  }
  for (const receipt of data.receipts.filter((item) => item.status !== 'POSTED')) {
    const voucher = bySource('RECEIPT', receipt._id);
    if (voucher) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          receipt.number,
          `The receipt is not confirmed but voucher ${voucher.number} exists.`,
        ),
      );
    }
  }
  for (const order of data.orders.filter((item) => item.margBill)) {
    const bill = order.margBill!;
    const voucher = bySource('MARG_BILL', order._id);
    if (!voucher) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          order.number,
          `Marg bill ${bill.invoiceNumber} has no SALES voucher.`,
        ),
      );
    } else if (voucher.totalPaise !== bill.totalPaise) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          order.number,
          `Marg bill ${bill.invoiceNumber} is ${formatRupees(bill.totalPaise)} but voucher ${voucher.number} is ${formatRupees(voucher.totalPaise)}.`,
        ),
      );
    }
  }
  for (const po of data.purchaseOrders.filter((item) => (item.acceptedValuePaise ?? 0) > 0)) {
    const voucher = vouchers.find(
      (item) => item.source.type === 'INSPECTION' && item.source.number === po.number,
    );
    if (!voucher) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          po.number,
          'Goods were accepted at the dock but there is no PURCHASE voucher.',
        ),
      );
    } else if (voucher.totalPaise !== po.acceptedValuePaise) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          po.number,
          `The accepted value is ${formatRupees(po.acceptedValuePaise ?? 0)} but voucher ${voucher.number} is ${formatRupees(voucher.totalPaise)}.`,
        ),
      );
    }
  }
  const paidLines = data.batches.flatMap((batch) =>
    batch.lines.filter((line) => line.status === 'PAID').map((line) => ({ batch, line })),
  );
  for (const { batch, line } of paidLines) {
    if (!bySource('PAYOUT_LINE', line._id)) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          batch.number,
          `Line ${line.reference} is paid but has no PAYMENT voucher.`,
        ),
      );
    }
  }

  // Voucher → document
  const lineIds = new Set(
    data.batches.flatMap((batch) => batch.lines.map((line) => key(line._id))),
  );
  const inspections = await presentIds(
    (ids) => InspectionModel.find({ _id: { $in: ids } }, { _id: 1 }),
    vouchers.filter((v) => v.source.type === 'INSPECTION').map((v) => v.source.id),
  );
  const complaints = await presentIds(
    (ids) => ComplaintModel.find({ _id: { $in: ids } }, { _id: 1 }),
    vouchers.filter((v) => v.source.type === 'COMPLAINT').map((v) => v.source.id),
  );
  const receiptIds = new Set(
    data.receipts.filter((item) => item.status === 'POSTED').map((item) => key(item._id)),
  );
  const billedOrderIds = new Set(
    data.orders.filter((item) => item.margBill).map((item) => key(item._id)),
  );
  for (const voucher of vouchers) {
    const { type, id } = voucher.source;
    const has =
      type === 'RECEIPT'
        ? receiptIds.has(key(id))
        : type === 'MARG_BILL'
          ? billedOrderIds.has(key(id))
          : type === 'INSPECTION'
            ? inspections.has(key(id))
            : type === 'PAYOUT_LINE'
              ? lineIds.has(key(id))
              : complaints.has(key(id));
    if (!has) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          voucher.number,
          `The ${type.toLowerCase().replace('_', ' ')} behind this voucher does not exist.`,
        ),
      );
    }
    const wanted = VOUCHER_TYPE_OF_SOURCE[type];
    if (wanted && voucher.type !== wanted) {
      findings.push(
        find(
          'VOUCHER_SOURCE',
          voucher.number,
          `A voucher from a ${type.toLowerCase().replace('_', ' ')} should be ${wanted}, not ${voucher.type}.`,
        ),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// The run

/** Everything the checks read, loaded once. Fine for TriFid's volume (a few thousand records). */
async function load() {
  const [orders, purchaseOrders, receipts, trades, vouchers, batches] = await Promise.all([
    SalesOrderModel.find().lean(),
    PurchaseOrderModel.find().lean(),
    ReceiptModel.find().lean(),
    TradeModel.find({}, { number: 1, salesOrderId: 1 }).lean(),
    VoucherModel.find().lean(),
    PayoutBatchModel.find().lean(),
  ]);
  return { orders, purchaseOrders, receipts, trades, vouchers, batches };
}
type Data = Awaited<ReturnType<typeof load>>;

/** Runs every check once and saves the run. A crash is saved as a FAILED run, so it is never silent. */
export async function runIntegrityCheck(
  trigger: JobTrigger,
  startedBy?: Types.ObjectId | string,
  startedAt = new Date(),
) {
  try {
    const data = await load();
    const findings = [
      ...(await orphans(data)),
      ...totals(data),
      ...trialBalance(data),
      ...(await voucherSources(data)),
    ];
    return await JobRunModel.create({
      job: 'INTEGRITY_CHECK',
      trigger,
      ...(startedBy ? { startedBy } : {}),
      startedAt,
      finishedAt: new Date(),
      status: findings.length === 0 ? 'OK' : 'FINDINGS',
      checked: {
        salesOrders: data.orders.length,
        purchaseOrders: data.purchaseOrders.length,
        receipts: data.receipts.length,
        vouchers: data.vouchers.length,
      },
      findingCount: findings.length,
      findings: findings.slice(0, MAX_STORED_FINDINGS),
    });
  } catch (error) {
    logger.error({ msg: 'The integrity check failed', error });
    return JobRunModel.create({
      job: 'INTEGRITY_CHECK',
      trigger,
      ...(startedBy ? { startedBy } : {}),
      startedAt,
      finishedAt: new Date(),
      status: 'FAILED',
      checked: { salesOrders: 0, purchaseOrders: 0, receipts: 0, vouchers: 0 },
      findingCount: 0,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
}

/** The most recent run, or null when it has never run. */
export function lastIntegrityRun() {
  return JobRunModel.findOne({ job: 'INTEGRITY_CHECK' }).sort({ startedAt: -1 });
}

/** A run as the pages show it. */
export function runView(run: NonNullable<Awaited<ReturnType<typeof lastIntegrityRun>>>) {
  return {
    id: run.id,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    checked: run.checked,
    findingCount: run.findingCount,
    findings: run.findings.map((item) => ({
      check: item.check,
      ref: item.ref,
      message: item.message,
    })),
    error: run.error ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The nightly schedule

const NIGHTLY_HOUR_IST = 2;

/**
 * Called by the clock timer every 15 minutes. From 2 am Indian time it runs the check once for the day: if a run
 * (nightly or manual) already started today, it does nothing. Returns true when it ran the check.
 */
export async function runIntegrityIfDue(now = new Date()): Promise<boolean> {
  const hour = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
  if (hour < NIGHTLY_HOUR_IST) return false;
  const last = await lastIntegrityRun();
  if (last && istDate(last.startedAt) === istDate(now)) return false;
  await runIntegrityCheck('SCHEDULE', undefined, now);
  return true;
}
