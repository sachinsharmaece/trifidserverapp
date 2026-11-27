import { z } from 'zod';
import {
  LedgerGroupModel,
  LedgerModel,
  PurchaseOrderModel,
  SalesOrderModel,
  VoucherModel,
} from '../../models/index.js';
import { invalidField } from '../../shared/errors.js';
import { rupees, toCsv } from '../../shared/csv.js';
import { escapeRegex } from '../../shared/mongo.js';
import { pagingShape } from '../parties/common.js';

/**
 * The registers and the trial balance (SRS-RPT-02, SRS-RPT-03, SRS-ACC-08). They are read from the VOUCHERS, the
 * only books (Q-ACC-09): a SALES voucher is one Marg bill, a PURCHASE voucher is one dock acceptance. The buyer
 * and the seller are looked up from the order each voucher came from.
 *
 * The two registers are two separate lists on purpose: no row names a buyer and a seller together (SRS-ACC-07).
 * Nothing here reads a selling rate, a seller's rate or the margin.
 */

/** A real calendar day, YYYY-MM-DD: "2026-02-31" and "2026-13-01" are refused. */
function isRealDay(text: string): boolean {
  const at = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .refine(isRealDay, { message: 'This is not a real date.' });

export const registerQuery = z.object({
  ...pagingShape,
  from: day.optional(),
  to: day.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type RegisterQuery = z.output<typeof registerQuery>;

/** A download holds every row of the range, up to this many. A bigger range must be split by date. */
export const CSV_ROW_LIMIT = 50_000;

function dateFilter({ from, to }: Pick<RegisterQuery, 'from' | 'to'>) {
  if (from && to && from > to) throw invalidField('to', 'The end date is before the start date.');
  if (!from && !to) return {};
  return { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } };
}

interface GstSums {
  count: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/** Totals over every voucher that matches (not only the page on screen). */
async function sumsOf(match: Record<string, unknown>): Promise<GstSums> {
  const [sums] = await VoucherModel.aggregate<GstSums>([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        taxablePaise: { $sum: '$gst.taxablePaise' },
        cgstPaise: { $sum: '$gst.cgstPaise' },
        sgstPaise: { $sum: '$gst.sgstPaise' },
        igstPaise: { $sum: '$gst.igstPaise' },
        totalPaise: { $sum: '$totalPaise' },
      },
    },
  ]);
  return {
    count: sums?.count ?? 0,
    taxablePaise: sums?.taxablePaise ?? 0,
    cgstPaise: sums?.cgstPaise ?? 0,
    sgstPaise: sums?.sgstPaise ?? 0,
    igstPaise: sums?.igstPaise ?? 0,
    totalPaise: sums?.totalPaise ?? 0,
  };
}

/** The tax split of a voucher (zeros when it has none). */
function gstOf(voucher: { gst?: Partial<GstSums> | null }) {
  const gst = voucher.gst;
  return {
    taxablePaise: gst?.taxablePaise ?? 0,
    cgstPaise: gst?.cgstPaise ?? 0,
    sgstPaise: gst?.sgstPaise ?? 0,
    igstPaise: gst?.igstPaise ?? 0,
  };
}

/**
 * Vouchers a REVERSAL has undone do not stand, so they are left out of the registers and their totals (the
 * reversal itself is no SALES or PURCHASE voucher, so it never shows). After a dock correction the purchase
 * register therefore holds only the corrected voucher (Build 9).
 */
async function notReversed() {
  const reversals = await VoucherModel.find({ type: 'REVERSAL' }, { source: 1 }).lean();
  return reversals.length > 0 ? { _id: { $nin: reversals.map((item) => item.source.id) } } : {};
}

/** Which vouchers and how many of them: one page for the screen, or all of them for a download. */
function pageOptions(query: RegisterQuery) {
  if (query.format === 'csv') return { skip: 0, limit: CSV_ROW_LIMIT };
  return { skip: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

// ---------------------------------------------------------------------------------------------------------------
// Sales register

export async function salesRegister(query: RegisterQuery) {
  const match: Record<string, unknown> = {
    type: 'SALES',
    ...dateFilter(query),
    ...(await notReversed()),
  };
  if (query.q) {
    const words = new RegExp(escapeRegex(query.q), 'i');
    const orders = await SalesOrderModel.find(
      {
        $or: [
          { number: words },
          { 'margBill.invoiceNumber': words },
          { 'margBill.ewayBillNumber': words },
          { 'buyerSnapshot.number': words },
          { 'buyerSnapshot.firmName': words },
          { 'buyerSnapshot.gstin': words },
        ],
      },
      { _id: 1 },
    );
    match.$or = [{ number: words }, { 'source.id': { $in: orders.map((order) => order._id) } }];
  }

  const { skip, limit } = pageOptions(query);
  const [totals, vouchers] = await Promise.all([
    sumsOf(match),
    VoucherModel.find(match).sort({ date: 1, postedAt: 1 }).skip(skip).limit(limit),
  ]);
  const orders = await SalesOrderModel.find({ _id: { $in: vouchers.map((v) => v.source.id) } });

  const rows = vouchers.map((voucher) => {
    const order = orders.find((item) => item._id.equals(voucher.source.id));
    const buyerLine = voucher.lines.find((line) => line.drPaise > 0);
    return {
      voucherNumber: voucher.number,
      date: voucher.date,
      invoiceNumber: voucher.source.number,
      ewayBillNumber: order?.margBill?.ewayBillNumber ?? null,
      orderNumber: order?.number ?? null,
      buyer: {
        number: order?.buyerSnapshot.number ?? '',
        firmName: order?.buyerSnapshot.firmName ?? buyerLine?.ledgerName ?? '',
      },
      gstin: order?.buyerSnapshot.gstin ?? null,
      ...gstOf(voucher),
      totalPaise: voucher.totalPaise,
    };
  });
  return { rows, totals, total: totals.count, page: query.page, pageSize: query.pageSize };
}

export type SalesRegister = Awaited<ReturnType<typeof salesRegister>>;

export function salesRegisterCsv(rows: SalesRegister['rows']): string {
  return toCsv(
    [
      'Invoice no.',
      'E-way bill no.',
      'Invoice date',
      'Buyer',
      'Buyer GSTIN',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Invoice total',
      'Voucher no.',
      'Order no.',
    ],
    rows.map((row) => [
      row.invoiceNumber,
      row.ewayBillNumber,
      row.date,
      row.buyer.firmName,
      row.gstin,
      rupees(row.taxablePaise),
      rupees(row.cgstPaise),
      rupees(row.sgstPaise),
      rupees(row.igstPaise),
      rupees(row.totalPaise),
      row.voucherNumber,
      row.orderNumber,
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Purchase register

export async function purchaseRegister(query: RegisterQuery) {
  const match: Record<string, unknown> = {
    type: 'PURCHASE',
    ...dateFilter(query),
    ...(await notReversed()),
  };
  if (query.q) {
    const words = new RegExp(escapeRegex(query.q), 'i');
    const orders = await PurchaseOrderModel.find(
      {
        $or: [
          { number: words },
          { 'sellerSnapshot.number': words },
          { 'sellerSnapshot.firmName': words },
          { 'sellerSnapshot.gstin': words },
          { 'sellerBill.number': words },
        ],
      },
      { number: 1 },
    );
    match.$or = [{ number: words }, { 'source.number': { $in: orders.map((po) => po.number) } }];
  }

  const { skip, limit } = pageOptions(query);
  const [totals, vouchers] = await Promise.all([
    sumsOf(match),
    VoucherModel.find(match).sort({ date: 1, postedAt: 1 }).skip(skip).limit(limit),
  ]);
  // A PURCHASE voucher's source number is its PO number.
  const orders = await PurchaseOrderModel.find({
    number: { $in: vouchers.map((voucher) => voucher.source.number) },
  });

  const rows = vouchers.map((voucher) => {
    const po = orders.find((item) => item.number === voucher.source.number);
    const sellerLine = voucher.lines.find((line) => line.crPaise > 0);
    return {
      voucherNumber: voucher.number,
      date: voucher.date,
      poNumber: voucher.source.number,
      seller: {
        number: po?.sellerSnapshot.number ?? '',
        firmName: po?.sellerSnapshot.firmName ?? sellerLine?.ledgerName ?? '',
      },
      gstin: po?.sellerSnapshot.gstin ?? null,
      // Entered by Purchase before the seller is paid; empty until then.
      sellerBill: po?.sellerBill
        ? {
            number: po.sellerBill.number,
            billDate: po.sellerBill.billDate,
            amountPaise: po.sellerBill.amountPaise,
          }
        : null,
      ...gstOf(voucher),
      totalPaise: voucher.totalPaise,
    };
  });
  return { rows, totals, total: totals.count, page: query.page, pageSize: query.pageSize };
}

export type PurchaseRegister = Awaited<ReturnType<typeof purchaseRegister>>;

export function purchaseRegisterCsv(rows: PurchaseRegister['rows']): string {
  return toCsv(
    [
      'Seller bill no.',
      'Seller bill date',
      'Seller bill amount',
      'Seller',
      'Seller GSTIN',
      'Accepted on',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Accepted total',
      'Voucher no.',
      'PO no.',
    ],
    rows.map((row) => [
      row.sellerBill?.number ?? '',
      row.sellerBill?.billDate ?? '',
      row.sellerBill ? rupees(row.sellerBill.amountPaise) : '',
      row.seller.firmName,
      row.gstin,
      row.date,
      rupees(row.taxablePaise),
      rupees(row.cgstPaise),
      rupees(row.sgstPaise),
      rupees(row.igstPaise),
      rupees(row.totalPaise),
      row.voucherNumber,
      row.poNumber,
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Trial balance

export const trialBalanceQuery = z.object({
  asOn: day.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/**
 * Every ledger's closing balance on the day (or today), in a Debit and a Credit column. The two columns must
 * add up to the same total: if they do not, `balanced` is false and the integrity check reports it too.
 */
export async function trialBalance(asOn?: string) {
  const sums = await VoucherModel.aggregate<{ _id: unknown; drPaise: number; crPaise: number }>([
    { $match: asOn ? { date: { $lte: asOn } } : {} },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.ledgerId',
        drPaise: { $sum: '$lines.drPaise' },
        crPaise: { $sum: '$lines.crPaise' },
      },
    },
  ]);
  const [ledgers, groups] = await Promise.all([
    LedgerModel.find({ _id: { $in: sums.map((sum) => sum._id) } }),
    LedgerGroupModel.find(),
  ]);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));

  const rows = sums
    .map((sum) => {
      const ledger = ledgers.find((item) => String(item._id) === String(sum._id));
      const net = sum.drPaise - sum.crPaise;
      return {
        ledgerId: String(sum._id),
        name: ledger?.name ?? '(missing ledger)',
        group: ledger ? (groupName.get(String(ledger.groupId)) ?? '') : '',
        debitPaise: net > 0 ? net : 0,
        creditPaise: net < 0 ? -net : 0,
      };
    })
    .filter((row) => row.debitPaise > 0 || row.creditPaise > 0)
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  const debitPaise = rows.reduce((sum, row) => sum + row.debitPaise, 0);
  const creditPaise = rows.reduce((sum, row) => sum + row.creditPaise, 0);
  return {
    asOn: asOn ?? null,
    rows,
    totals: { debitPaise, creditPaise },
    balanced: debitPaise === creditPaise,
  };
}

export type TrialBalance = Awaited<ReturnType<typeof trialBalance>>;

export function trialBalanceCsv(report: TrialBalance): string {
  return toCsv(
    ['Ledger', 'Group', 'Debit', 'Credit'],
    [
      ...report.rows.map((row) => [
        row.name,
        row.group,
        row.debitPaise ? rupees(row.debitPaise) : '',
        row.creditPaise ? rupees(row.creditPaise) : '',
      ]),
      ['Total', '', rupees(report.totals.debitPaise), rupees(report.totals.creditPaise)],
    ],
  );
}
