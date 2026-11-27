import { z } from 'zod';
import {
  BuyerModel,
  InspectionModel,
  PurchaseOrderModel,
  SalesOrderModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees, splitGst } from '../../shared/money.js';
import { buyerLedger, postVoucher, systemLedger } from '../books/books.js';
import { istDate } from '../payments/payments.js';
import type { SalesOrderDoc } from '../salesOrders/salesOrders.js';
import type { CommandContext } from '../trades/commands.js';

/**
 * The Marg bill (FR-ACC-04, LOCK-40 L40.9). After the dock check, Accounts keys the invoice that Marg printed for
 * the buyer. The engine action `recordMargBill` runs the checks, then in one transaction saves the bill on the
 * sales order (BILLED) and posts the SALES voucher: Dr the buyer · Cr Sales (taxable) · Cr Output CGST + SGST
 * (or IGST). The bill then shows on Logistics' Billed list, ready for a trip.
 *
 * The checks (a refusal names the one that failed):
 *   1. something was accepted at the dock
 *   2. no line bills more boxes than were accepted
 *   3. the bill is not higher than accepted boxes × units per box × the buyer's rate (Q-ACC-02, decided 26 Nov
 *      2026: only a HIGHER bill is refused; a lower one is allowed and the difference is kept)
 *   4. the buyer owes nothing (the order is paid in full)
 *   5. "no open shortfall" is not checked: shortfalls across several orders (O6) are not built (Q-LOG-10)
 */

/** What the dock accepted, per order line, at the buyer's rate. Reads the latest dock check (counts only). */
export async function acceptedLines(order: SalesOrderDoc) {
  const po = await PurchaseOrderModel.findOne({ salesOrderId: order._id });
  const inspection = po?.latestInspectionId
    ? await InspectionModel.findById(po.latestInspectionId)
    : null;
  if (!po || !inspection) return null;
  const lines = order.lines.map((line) => {
    const checked = inspection.lines.find((item) => item.lineNo === line.lineNo);
    const acceptedBoxes = checked?.boxesAccepted ?? 0;
    return {
      lineNo: line.lineNo,
      productName: line.productName,
      packLabel: line.packLabel,
      unitsPerBox: line.unitsPerBox,
      orderedBoxes: line.boxes,
      acceptedBoxes,
      buyerRatePaisePerUnit: line.buyerRatePaisePerUnit,
      acceptedValuePaise: acceptedBoxes * line.unitsPerBox * line.buyerRatePaisePerUnit,
      // Movement data for the trip lists: what the dock found (or what was ordered).
      batch: checked?.batchFound ?? line.batchNumber ?? null,
      expiryMonth: checked?.expiryFound ?? line.expiryMonth,
    };
  });
  return {
    purchaseOrderId: po.id,
    inspectedAt: po.inspectedAt ?? null,
    lines,
    acceptedBoxes: lines.reduce((sum, line) => sum + line.acceptedBoxes, 0),
    expectedPaise: lines.reduce((sum, line) => sum + line.acceptedValuePaise, 0),
  };
}

/** The Marg bill as the buyer side shows it (deal card, order page, To be billed). */
export function margBillView(order: SalesOrderDoc) {
  const bill = order.margBill;
  if (!bill) return null;
  return {
    invoiceNumber: bill.invoiceNumber,
    ewayBillNumber: bill.ewayBillNumber ?? null,
    pdfFileId: bill.pdfFileId ? String(bill.pdfFileId) : null,
    billDate: bill.billDate,
    totalPaise: bill.totalPaise,
    expectedPaise: bill.expectedPaise,
    /** Positive when the bill is lower than the accepted value (allowed, Q-ACC-02). */
    shortByPaise: bill.expectedPaise - bill.totalPaise,
    lines: bill.lines.map((line) => ({ lineNo: line.lineNo, boxes: line.boxes })),
    at: bill.at,
  };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');

export const margBillInput = z.object({
  invoiceNumber: z.string().trim().min(1, 'Enter the Marg invoice number.').max(40),
  ewayBillNumber: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((text) => text || undefined),
  billDate: day,
  /** The Marg bill PDF, uploaded first through POST /uploads. */
  pdfFileId: z
    .string()
    .regex(/^[a-f0-9]{24}$/, 'Upload the bill PDF again.')
    .optional(),
  totalPaise: z.number().int().min(1, 'Enter the bill total.').max(100_000_000_000),
  lines: z
    .array(
      z.object({ lineNo: z.number().int().min(1), boxes: z.number().int().min(0).max(1_000_000) }),
    )
    .min(1, 'Enter the boxes billed.'),
});

/** The Marg bill: checks, then the bill on the order and the SALES voucher (see the top of this file). */
export async function recordMargBill(ctx: CommandContext, input: z.output<typeof margBillInput>) {
  const { req, trade, userId, now, session } = ctx;
  const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
  if (order.margBill) throw conflict('This order is already billed in Marg.', 'ALREADY_BILLED');
  if (input.billDate > istDate(now)) {
    throw invalidField('billDate', 'The bill date cannot be in the future.');
  }
  const accepted = await acceptedLines(order);
  // 1. Something was accepted.
  if (!accepted || accepted.acceptedBoxes === 0) {
    throw conflict(
      'Check 1: nothing was accepted at the dock, so there is nothing to bill.',
      'MARG_CHECK_1',
    );
  }
  // 2. No line bills more boxes than were accepted.
  input.lines.forEach((line, index) => {
    const found = accepted.lines.find((item) => item.lineNo === line.lineNo);
    if (!found)
      throw invalidField(`lines.${index}.lineNo`, `The order has no line ${line.lineNo}.`);
    if (line.boxes > found.acceptedBoxes) {
      throw invalidField(
        `lines.${index}.boxes`,
        `Check 2: only ${found.acceptedBoxes} boxes of this line were accepted at the dock.`,
      );
    }
  });
  const billed = input.lines.filter((line) => line.boxes > 0);
  if (billed.length === 0) throw invalidField('lines.0.boxes', 'Enter the boxes billed.');
  // 3. Not higher than the accepted boxes at the buyer's rate.
  if (input.totalPaise > accepted.expectedPaise) {
    throw invalidField(
      'totalPaise',
      `Check 3: the bill is ${formatRupees(input.totalPaise - accepted.expectedPaise)} more than the accepted boxes at the buyer's rate (${formatRupees(accepted.expectedPaise)}).`,
    );
  }
  // 4. The buyer owes nothing.
  if (order.paidPaise < order.totalPaise) {
    throw conflict('Check 4: the buyer still owes money on this order.', 'MARG_CHECK_4');
  }
  if (
    await SalesOrderModel.exists({ 'margBill.invoiceNumber': input.invoiceNumber }).session(session)
  ) {
    throw invalidField(
      'invoiceNumber',
      `Marg invoice ${input.invoiceNumber} is already used on another order.`,
    );
  }

  // The SALES voucher, at the bill total (tax inside, split like the order: IGST across states).
  const buyer = await BuyerModel.findById(order.buyerId).session(session).orFail();
  const taxBp = order.lines[0]!.taxBp;
  const gst = splitGst(input.totalPaise, taxBp, order.interState);
  const taxLines = order.interState
    ? [{ ledger: await systemLedger('OUTPUT_IGST', userId, session), crPaise: gst.igstPaise }]
    : [
        { ledger: await systemLedger('OUTPUT_CGST', userId, session), crPaise: gst.cgstPaise },
        { ledger: await systemLedger('OUTPUT_SGST', userId, session), crPaise: gst.sgstPaise },
      ];
  const voucher = await postVoucher(
    req,
    {
      type: 'SALES',
      date: input.billDate,
      narration: `Marg ${input.invoiceNumber} for ${order.number}`,
      source: { type: 'MARG_BILL', id: order._id, number: input.invoiceNumber },
      lines: [
        { ledger: await buyerLedger(buyer, userId, session), drPaise: input.totalPaise },
        { ledger: await systemLedger('SALES', userId, session), crPaise: gst.taxablePaise },
        ...taxLines.filter((line) => line.crPaise > 0),
      ],
      gst: { ...gst, taxBp },
      userId,
      now,
    },
    session,
  );

  const margBill = {
    invoiceNumber: input.invoiceNumber,
    ...(input.ewayBillNumber ? { ewayBillNumber: input.ewayBillNumber } : {}),
    ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
    billDate: input.billDate,
    totalPaise: input.totalPaise,
    expectedPaise: accepted.expectedPaise,
    lines: billed,
    voucherId: voucher._id,
    at: now,
    by: userId,
  };
  const result = await SalesOrderModel.updateOne(
    { _id: order._id, version: order.version },
    { $set: { status: 'BILLED', margBill }, $inc: { version: 1 } },
    { session, runValidators: true },
  );
  if (result.matchedCount !== 1) {
    throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
  }
  await writeAudit(req, {
    action: 'salesOrder.margBill',
    entityType: 'SalesOrder',
    entityId: order.id,
    before: { status: order.status },
    after: { status: 'BILLED', invoiceNumber: input.invoiceNumber, totalPaise: input.totalPaise },
    session,
  });

  const boxes = billed.reduce((sum, line) => sum + line.boxes, 0);
  const lower =
    input.totalPaise < accepted.expectedPaise
      ? ` (${formatRupees(accepted.expectedPaise - input.totalPaise)} less than the accepted value)`
      : '';
  return {
    note: `Billed in Marg: ${input.invoiceNumber}, ${boxes} boxes, ${formatRupees(input.totalPaise)}${lower} (${voucher.number}). Waiting for a trip`,
  };
}
