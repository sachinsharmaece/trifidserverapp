import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { numberSetting } from '../../db/settings.js';
import {
  CompanyModel,
  InspectionModel,
  VoucherModel,
  RefundModel,
  ReturnNoteModel,
  SalesOrderModel,
  SellerModel,
  SellerStrikeModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { InspectionOutcome } from '../../shared/enums.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees, HOME_STATE_CODE, splitGst } from '../../shared/money.js';
import { postReversal, postVoucher, sellerLedger, systemLedger } from '../books/books.js';
import { istDate } from '../../shared/dates.js';
import { purchaseOrderOf, savePurchaseOrder } from '../purchaseOrders/dispatch.js';
import type { PurchaseOrderDoc } from '../purchaseOrders/purchaseOrders.js';
import type { CommandContext } from '../trades/commands.js';
import { monthsFromNow } from '../trades/stages.js';
import { payoutsOfRefunds } from '../payouts/payouts.js';

/**
 * The Indore dock (LOCK-40 Part A, SRS-LOG-01..05). Two engine steps, pressed by Logistics from the Dock screen:
 *
 *   recordArrival  the goods reached the dock: when, how many boxes were counted, did the seller's bill come too
 *                  → PO ARRIVED, the inspection clock starts (INSPECTION_HOURS, 24)
 *   inspectLot     the check, line by line (Gate B) → PO CHECKED (or REJECTED when nothing passed)
 *   correctInspection  a wrong count found later (SRS-LOG-03, Build 9): a NEW check that replaces the first, allowed
 *                  until the Marg bill is saved or the seller's payout starts. The first check is kept as it was.
 *
 * What the check writes, all in the engine's transaction (ARCH A6.4):
 *   - the inspection (append-only)
 *   - accepted > 0: the PURCHASE voucher, accepted boxes × the seller's landed rate:
 *       Dr Purchase (taxable) · Dr Input CGST + SGST (or IGST) · Cr the seller
 *   - damaged or leaking boxes: a REJECTED return note; extra boxes: an EXCESS return note (30 days)
 *   - short, damaged or leaking boxes: a refund DUE to the buyer at his order's rate (paid later, with payouts)
 *   - nothing accepted (O4): a seller strike
 * Logistics never sees firm names or money: the Dock screen's rows leave them out (dock.routes.ts).
 */

const DEFAULTS = { INSPECTION_HOURS: 24, RETURN_NOTE_DAYS: 30, SHELF_LIFE_FLOOR_MONTHS: 6 };
const HOUR_MS = 60 * 60 * 1000;

export const arrivalInput = z.object({
  arrivedAt: z.iso.datetime({ offset: true, message: 'Enter when the goods arrived.' }),
  boxesCounted: z.number().int().min(1, 'Enter how many boxes arrived.').max(1_000_000),
  billWithGoods: z.boolean(),
});

/** The goods are at the dock. PO DISPATCHED → ARRIVED; the dock should check them within INSPECTION_HOURS. */
export async function recordArrival(ctx: CommandContext, input: z.output<typeof arrivalInput>) {
  const po = await purchaseOrderOf(ctx);
  if (po.status !== 'DISPATCHED' || !po.leg1) {
    throw conflict('Arrival is recorded once, after the dispatch.', 'WRONG_STAGE');
  }
  const arrivedAt = new Date(input.arrivedAt);
  if (arrivedAt.getTime() > ctx.now.getTime() + 5 * 60 * 1000) {
    throw invalidField('arrivedAt', 'The arrival time cannot be in the future.');
  }
  if (istDate(arrivedAt) < po.leg1.dispatchedOn) {
    throw invalidField('arrivedAt', `The goods were dispatched on ${po.leg1.dispatchedOn}.`);
  }
  const hours = await numberSetting('INSPECTION_HOURS', DEFAULTS.INSPECTION_HOURS);
  const inspectBy = new Date(ctx.now.getTime() + hours * HOUR_MS);
  const arrival = { ...input, arrivedAt, at: ctx.now, by: ctx.userId };
  await savePurchaseOrder(
    ctx,
    po,
    { status: 'ARRIVED', arrival, inspectBy },
    {
      action: 'purchaseOrder.arrival',
      before: { status: po.status },
      after: { status: 'ARRIVED', boxesCounted: input.boxesCounted },
    },
  );
  const ordered = po.lines.reduce((sum, line) => sum + line.boxes, 0);
  return { po, inspectBy, ordered };
}

export const inspectionInput = z.object({
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        batchFound: z
          .string()
          .trim()
          .max(60)
          .optional()
          .transform((text) => text || undefined),
        expiryFound: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the expiry month as YYYY-MM.')
          .optional(),
        damagedBoxes: z.number().int().min(0).max(1_000_000).default(0),
        leakingBoxes: z.number().int().min(0).max(1_000_000).default(0),
        excessBoxes: z.number().int().min(0).max(1_000_000).default(0),
      }),
    )
    .min(1, 'Check every line of the PO.'),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((text) => text || undefined),
});
type InspectionInput = z.output<typeof inspectionInput>;

const same = (a?: string | null, b?: string | null) =>
  Boolean(a && b) && a!.trim().toUpperCase() === b!.trim().toUpperCase();

/** The first that applies of O4, O2, O3, O5, else O1 (LOCK-40 A2). */
function outcomeOf(t: { accepted: number; rejected: number; short: number; excess: number }) {
  if (t.accepted === 0) return 'O4';
  if (t.rejected > 0) return 'O2';
  if (t.short > 0) return 'O3';
  if (t.excess > 0) return 'O5';
  return 'O1';
}

/**
 * Works out each line from what the dock typed and the arrival count (no writes). Short boxes are never typed:
 * ordered − counted, taken from the lines in PO order (L40.5). Refuses impossible counts with a 422 on the field.
 */
export function inspectionLines(
  po: {
    lines: {
      lineNo: number;
      skuId: unknown;
      boxes: number;
      expiryMonth: string;
      batchNumber?: string | null;
    }[];
    leg1?: {
      lines: {
        lineNo: number;
        batchDeclared?: string | null;
        expiryDeclared?: string | null;
        shortExpiryAgreed: boolean;
      }[];
    } | null;
  },
  boxesCounted: number,
  input: InspectionInput,
  shelfFloorMonths: number,
  now: Date,
) {
  const ordered = po.lines.reduce((sum, line) => sum + line.boxes, 0);
  const extra = Math.max(0, boxesCounted - ordered);
  let shortLeft = Math.max(0, ordered - boxesCounted);

  input.lines.forEach((given, index) => {
    if (!po.lines.some((line) => line.lineNo === given.lineNo)) {
      throw invalidField(`lines.${index}.lineNo`, `The PO has no line ${given.lineNo}.`);
    }
  });
  const lines = po.lines.map((poLine) => {
    const index = input.lines.findIndex((given) => given.lineNo === poLine.lineNo);
    if (index < 0) throw invalidField('lines', `Check line ${poLine.lineNo} too.`);
    const given = input.lines[index]!;
    const declared = po.leg1?.lines.find((line) => line.lineNo === poLine.lineNo);
    const boxesShort = Math.min(shortLeft, poLine.boxes);
    shortLeft -= boxesShort;
    const present = poLine.boxes - boxesShort;
    if (given.damagedBoxes + given.leakingBoxes > present) {
      throw invalidField(
        `lines.${index}.damagedBoxes`,
        `Only ${present} box${present === 1 ? '' : 'es'} of this line arrived.`,
      );
    }
    const expectedBatch = declared?.batchDeclared ?? poLine.batchNumber ?? null;
    const expectedExpiry = declared?.expiryDeclared ?? poLine.expiryMonth;
    const shortExpiryAgreed = declared?.shortExpiryAgreed ?? false;
    return {
      lineNo: poLine.lineNo,
      skuId: poLine.skuId,
      boxesOnPo: poLine.boxes,
      boxesShort,
      boxesDamaged: given.damagedBoxes,
      boxesLeaking: given.leakingBoxes,
      boxesAccepted: present - given.damagedBoxes - given.leakingBoxes,
      boxesExcess: given.excessBoxes,
      ...(given.batchFound ? { batchFound: given.batchFound } : {}),
      ...(given.expiryFound ? { expiryFound: given.expiryFound } : {}),
      batchDiffers:
        Boolean(given.batchFound && expectedBatch) && !same(given.batchFound, expectedBatch),
      expiryDiffers: Boolean(given.expiryFound) && given.expiryFound !== expectedExpiry,
      belowShelfLife:
        Boolean(given.expiryFound) &&
        !shortExpiryAgreed &&
        monthsFromNow(given.expiryFound!, now) < shelfFloorMonths,
      shortExpiryAgreed,
    };
  });

  const excess = lines.reduce((sum, line) => sum + line.boxesExcess, 0);
  if (excess !== extra) {
    throw invalidField(
      'lines.0.excessBoxes',
      extra === 0
        ? `${boxesCounted} boxes were counted for ${ordered} ordered: there are no extra boxes.`
        : `${boxesCounted} boxes were counted for ${ordered} ordered: the extra boxes must add up to ${extra}.`,
    );
  }
  const totals = {
    ordered,
    accepted: lines.reduce((sum, line) => sum + line.boxesAccepted, 0),
    short: lines.reduce((sum, line) => sum + line.boxesShort, 0),
    damaged: lines.reduce((sum, line) => sum + line.boxesDamaged, 0),
    leaking: lines.reduce((sum, line) => sum + line.boxesLeaking, 0),
    excess,
  };
  const outcome: InspectionOutcome = outcomeOf({
    accepted: totals.accepted,
    rejected: totals.damaged + totals.leaking,
    short: totals.short,
    excess,
  });
  return { lines, totals, outcome };
}

/** "2 short, 1 damaged" — the boxes that did not pass, in words. */
function failedText(t: { short: number; damaged: number; leaking: number }) {
  return [
    t.short ? `${t.short} short` : '',
    t.damaged ? `${t.damaged} damaged` : '',
    t.leaking ? `${t.leaking} leaking` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Gate B: the dock's check of the goods (see the top of this file for what it writes). */
export async function inspectLot(ctx: CommandContext, input: InspectionInput) {
  const po = await purchaseOrderOf(ctx);
  if (po.status !== 'ARRIVED' || !po.arrival) {
    throw conflict('Record the arrival first.', 'WRONG_STAGE');
  }
  return saveCheck(ctx, po, input, null);
}

type InspectionDoc = InstanceType<typeof InspectionModel>;

/**
 * Writes one check and everything that follows from it. Used for the first check and, with `replaces`, for a
 * correction. `po.arrival` is set (both callers have checked it).
 */
async function saveCheck(
  ctx: CommandContext,
  po: PurchaseOrderDoc,
  input: InspectionInput,
  replaces: InspectionDoc | null,
) {
  const { req, trade, userId, now, session } = ctx;
  if (!po.arrival) throw conflict('Record the arrival first.', 'WRONG_STAGE');
  const floor = await numberSetting('SHELF_LIFE_FLOOR_MONTHS', DEFAULTS.SHELF_LIFE_FLOOR_MONTHS);
  const { lines, totals, outcome } = inspectionLines(
    po,
    po.arrival.boxesCounted,
    input,
    floor,
    now,
  );

  // Seller side: accepted boxes at his landed rate.
  const acceptedValuePaise = lines.reduce((sum, line) => {
    const poLine = po.lines.find((item) => item.lineNo === line.lineNo)!;
    return sum + line.boxesAccepted * poLine.unitsPerBox * poLine.landedPaisePerUnit;
  }, 0);

  const [inspection] = await InspectionModel.create(
    [
      {
        purchaseOrderId: po._id,
        tradeId: trade._id,
        boxesCounted: po.arrival.boxesCounted,
        lines,
        ...(input.note ? { note: input.note } : {}),
        outcome,
        acceptedBoxes: totals.accepted,
        acceptedValuePaise,
        ...(replaces ? { correctsId: replaces._id } : {}),
        savedBy: userId,
        savedAt: now,
      },
    ],
    { session },
  );
  if (!inspection) throw new Error('The inspection was not saved');

  // Gate B: the PURCHASE voucher for what was accepted (tax inside, like every rate).
  const order = await SalesOrderModel.findById(po.salesOrderId).session(session).orFail();
  const orderLine = order.lines[0]!;
  let voucherNumber: string | null = null;
  if (acceptedValuePaise > 0) {
    const seller = await SellerModel.findById(po.sellerId).session(session).orFail();
    const company = await CompanyModel.findOne().session(session);
    const interState = seller.gstin.slice(0, 2) !== (company?.stateCode ?? HOME_STATE_CODE);
    const gst = splitGst(acceptedValuePaise, orderLine.taxBp, interState);
    const taxLines = interState
      ? [{ ledger: await systemLedger('INPUT_IGST', userId, session), drPaise: gst.igstPaise }]
      : [
          { ledger: await systemLedger('INPUT_CGST', userId, session), drPaise: gst.cgstPaise },
          { ledger: await systemLedger('INPUT_SGST', userId, session), drPaise: gst.sgstPaise },
        ];
    const voucher = await postVoucher(
      req,
      {
        type: 'PURCHASE',
        date: istDate(now),
        narration: `${po.number}: ${totals.accepted} boxes accepted at the dock${replaces ? ' (corrected check)' : ''}`,
        source: { type: 'INSPECTION', id: inspection._id, number: po.number },
        lines: [
          { ledger: await systemLedger('PURCHASE', userId, session), drPaise: gst.taxablePaise },
          ...taxLines.filter((line) => line.drPaise > 0),
          { ledger: await sellerLedger(seller, userId, session), crPaise: acceptedValuePaise },
        ],
        gst: { ...gst, taxBp: orderLine.taxBp },
        userId,
        now,
      },
      session,
    );
    voucherNumber = voucher.number;
  }

  // Return notes: damaged or leaking boxes go back; so do extra boxes.
  const days = await numberSetting('RETURN_NOTE_DAYS', DEFAULTS.RETURN_NOTE_DAYS);
  const item = po.lines.map((line) => `${line.productName} · ${line.packLabel}`).join('; ');
  const notesToWrite = [
    ...(totals.damaged + totals.leaking > 0
      ? [
          {
            type: 'REJECTED' as const,
            boxes: totals.damaged + totals.leaking,
            reason: failedText({ short: 0, damaged: totals.damaged, leaking: totals.leaking }),
          },
        ]
      : []),
    ...(totals.excess > 0
      ? [
          {
            type: 'EXCESS' as const,
            boxes: totals.excess,
            reason: `${totals.excess} more than ordered`,
          },
        ]
      : []),
  ];
  const returnNotes = [];
  for (const note of notesToWrite) {
    const [saved] = await ReturnNoteModel.create(
      [
        {
          number: await nextDocumentNumber('RTN', { session, at: now }),
          purchaseOrderId: po._id,
          tradeId: trade._id,
          inspectionId: inspection._id,
          sellerId: po.sellerId,
          ...note,
          item,
          dueAt: new Date(now.getTime() + days * 24 * HOUR_MS),
          createdBy: userId,
        },
      ],
      { session },
    );
    if (!saved) throw new Error('The return note was not saved');
    await writeAudit(req, {
      action: 'returnNote.create',
      entityType: 'ReturnNote',
      entityId: saved.id,
      after: { number: saved.number, type: saved.type, boxes: saved.boxes },
      session,
    });
    returnNotes.push(saved);
  }

  // Buyer side: boxes that did not pass are refunded at his order's rate (paid later, with payouts).
  const failedBoxes = totals.short + totals.damaged + totals.leaking;
  let refund = null;
  if (failedBoxes > 0) {
    const amountPaise = failedBoxes * orderLine.unitsPerBox * orderLine.buyerRatePaisePerUnit;
    const [saved] = await RefundModel.create(
      [
        {
          number: await nextDocumentNumber('REF', { session, at: now }),
          buyerId: order.buyerId,
          salesOrderId: order._id,
          tradeId: trade._id,
          reason: `Dock: ${failedText(totals)} (${order.number})`,
          boxes: failedBoxes,
          amountPaise,
          createdBy: userId,
        },
      ],
      { session },
    );
    if (!saved) throw new Error('The refund was not saved');
    await writeAudit(req, {
      action: 'refund.create',
      entityType: 'Refund',
      entityId: saved.id,
      after: { number: saved.number, amountPaise, salesOrder: order.number },
      session,
    });
    refund = saved;
  }

  if (outcome === 'O4') {
    await SellerStrikeModel.create(
      [
        {
          sellerId: po.sellerId,
          purchaseOrderId: po._id,
          kind: 'DOCK_REJECTED',
          at: now,
          by: userId,
        },
      ],
      { session },
    );
  }

  await savePurchaseOrder(
    ctx,
    po,
    {
      status: outcome === 'O4' ? 'REJECTED' : 'CHECKED',
      latestInspectionId: inspection._id,
      outcome,
      acceptedBoxes: totals.accepted,
      acceptedValuePaise,
      // A correction keeps the PO's place in the queue: `inspectedAt` is the day of the first check.
      ...(replaces ? {} : { inspectedAt: now }),
    },
    replaces
      ? {
          action: 'purchaseOrder.inspectCorrection',
          before: {
            outcome: replaces.outcome,
            acceptedBoxes: replaces.acceptedBoxes,
            acceptedValuePaise: replaces.acceptedValuePaise,
          },
          after: { outcome, acceptedBoxes: totals.accepted, acceptedValuePaise },
        }
      : {
          action: 'purchaseOrder.inspect',
          before: { status: po.status },
          after: { outcome, acceptedBoxes: totals.accepted, acceptedValuePaise },
        },
  );

  return {
    corrected: replaces !== null,
    outcome,
    totals,
    voucherNumber,
    acceptedValuePaise,
    returnNotes: returnNotes.map((note) => note.number),
    refund: refund ? { number: refund.number, amountPaise: refund.amountPaise } : null,
    failed: failedText(totals),
    order,
  };
}

/**
 * Why a PO's check can no longer be corrected, or null when it can. The three things that make a check final:
 * the seller's payout has started, the Marg bill is saved (the bill carries the accepted boxes to the buyer), or a
 * return note was closed (the boxes already went back). Also used by the Dock screen to show the button.
 */
export async function correctionBlock(
  po: Pick<
    PurchaseOrderDoc,
    'status' | 'payoutBatchId' | 'paidAt' | 'salesOrderId' | 'tradeId' | '_id'
  > & {
    latestInspectionId?: Types.ObjectId | null;
  },
  session?: ClientSession,
) {
  if (po.status === 'REJECTED') {
    return 'The dock rejected the whole lot, so it cannot be corrected. Sales may reopen the deal.';
  }
  if (po.status !== 'CHECKED' || !po.latestInspectionId)
    return 'Only a checked lot can be corrected.';
  if (po.payoutBatchId || po.paidAt) {
    return "The seller's payout has started, so the check can no longer be corrected.";
  }
  const order = await SalesOrderModel.findById(po.salesOrderId, { margBill: 1 }).session(
    session ?? null,
  );
  if (order?.margBill) return 'The Marg bill is saved, so the check can no longer be corrected.';
  const closed = await ReturnNoteModel.findOne({
    inspectionId: po.latestInspectionId,
    state: 'CLOSED',
  }).session(session ?? null);
  if (closed) {
    return `${closed.number} is already closed (the boxes went back), so the check can no longer be corrected.`;
  }
  const inPayout = (await checkRefunds(po.tradeId, session)).find(
    (refund) => refund.status === 'PAID' || refund.payoutBatchId,
  );
  if (inPayout) {
    return `${inPayout.number} is already in a payout, so the check can no longer be corrected.`;
  }
  return null;
}

/** The refunds the dock check created for a trade (not the complaint ones), apart from cancelled ones. */
function checkRefunds(tradeId: Types.ObjectId, session?: ClientSession) {
  return RefundModel.find({
    tradeId,
    complaintId: { $exists: false },
    status: { $ne: 'CANCELLED' },
  }).session(session ?? null);
}

/**
 * Correct a saved check (SRS-LOG-03, Build 9). Logistics typed a wrong count and sees it before the Marg bill is
 * saved. Everything the first check wrote is undone, and the new check writes it again:
 *   - its PURCHASE voucher is reversed (RX) and a new one posted for the new accepted boxes
 *   - its open return notes are cancelled and its refund (if not yet in a payout) is cancelled; new ones follow
 *   - the PO shows the new result; the first check stays in `inspections`, and the new one points back to it
 * Not allowed: a closed return note, a started payout, a saved Marg bill, or "nothing accepted" (that is a
 * rejection of the lot, not a correction). The arrival count is not changed here.
 */
export async function correctInspection(ctx: CommandContext, input: InspectionInput) {
  const { req, trade, userId, now, session } = ctx;
  const po = await purchaseOrderOf(ctx);
  const blocked = await correctionBlock(po, session);
  if (blocked) throw conflict(blocked, 'CORRECTION_NOT_ALLOWED');
  if (!po.arrival || !po.latestInspectionId) {
    throw conflict('Only a checked lot can be corrected.', 'WRONG_STAGE');
  }
  const previous = await InspectionModel.findById(po.latestInspectionId).session(session).orFail();

  // The refund of the first check (if it had one): correctionBlock has made sure it is not in a payout yet.
  const refunds = await checkRefunds(trade._id, session);
  // Refuse a whole-lot rejection BEFORE anything is written.
  const floor = await numberSetting('SHELF_LIFE_FLOOR_MONTHS', DEFAULTS.SHELF_LIFE_FLOOR_MONTHS);
  const wanted = inspectionLines(po, po.arrival.boxesCounted, input, floor, now);
  if (wanted.totals.accepted === 0) {
    throw invalidField(
      'lines',
      'At least one box must stay accepted. A lot that failed completely is not a correction.',
    );
  }

  // Undo what the first check wrote.
  const notes = await ReturnNoteModel.find({
    inspectionId: previous._id,
    state: 'OPEN',
  }).session(session);
  for (const note of notes) {
    await ReturnNoteModel.updateOne(
      { _id: note._id, state: 'OPEN' },
      { $set: { state: 'CANCELLED', cancelledAt: now }, $inc: { version: 1 } },
      { session },
    );
    await writeAudit(req, {
      action: 'returnNote.cancel',
      entityType: 'ReturnNote',
      entityId: note.id,
      before: { state: 'OPEN' },
      after: { state: 'CANCELLED', reason: 'Dock check corrected' },
      session,
    });
  }
  for (const refund of refunds) {
    await RefundModel.updateOne(
      { _id: refund._id, status: 'DUE' },
      { $set: { status: 'CANCELLED', cancelledAt: now } },
      { session },
    );
    await writeAudit(req, {
      action: 'refund.cancel',
      entityType: 'Refund',
      entityId: refund.id,
      before: { status: 'DUE' },
      after: { status: 'CANCELLED', reason: 'Dock check corrected' },
      session,
    });
  }
  const oldVoucher = await VoucherModel.findOne({
    type: 'PURCHASE',
    'source.type': 'INSPECTION',
    'source.id': previous._id,
  }).session(session);
  if (oldVoucher) {
    await postReversal(
      req,
      oldVoucher,
      { reason: `dock check of ${po.number} corrected`, userId, now },
      session,
    );
  }

  const result = await saveCheck(ctx, po, input, previous);
  return {
    ...result,
    before: {
      acceptedBoxes: previous.acceptedBoxes,
      acceptedValuePaise: previous.acceptedValuePaise,
    },
  };
}

/** The history notes of a correction: the buyer's refund may change, the seller's amount owed changes. */
export function correctionNotes(result: Awaited<ReturnType<typeof correctInspection>>) {
  const { totals } = result;
  const refund = result.refund
    ? ` Refund due to the buyer: ${formatRupees(result.refund.amountPaise)} (${result.refund.number}).`
    : ' No refund is due.';
  const why = result.failed ? ` (${result.failed})` : '';
  return {
    buyerNote: `Dock check corrected: ${totals.accepted} of ${totals.ordered} boxes accepted${why}.${refund}`,
    sellerNote: `Dock check corrected: ${totals.accepted} of ${totals.ordered} boxes accepted${why}. ${result.voucherNumber}: ${formatRupees(result.acceptedValuePaise)} owed to the seller (was ${formatRupees(result.before.acceptedValuePaise)}).`,
  };
}

/** The refunds owed on a sales order (buyer side of the wall: they tell our selling price). */
export async function refundsOf(salesOrderId: Types.ObjectId) {
  const refunds = await RefundModel.find({ salesOrderId }).sort({ createdAt: 1 });
  const payouts = await payoutsOfRefunds(refunds);
  return refunds.map((refund) => ({
    id: refund.id,
    number: refund.number,
    reason: refund.reason,
    boxes: refund.boxes,
    amountPaise: refund.amountPaise,
    status: refund.status,
    createdAt: refund.createdAt,
    /** Where its payout is: in a batch, released, or paid with the UTR (Build 5). */
    payout: payouts.get(refund.id) ?? null,
  }));
}

/** The notes for the trade's history: buyer side (refund, no seller money) and seller side (no buyer money). */
export function inspectionNotes(result: Awaited<ReturnType<typeof inspectLot>>) {
  const { totals, outcome } = result;
  const counted = `${totals.accepted} of ${totals.ordered} boxes accepted`;
  const refund = result.refund
    ? ` Refund due to the buyer: ${formatRupees(result.refund.amountPaise)} (${result.refund.number}).`
    : '';
  const returns = result.returnNotes.length ? ` Return note ${result.returnNotes.join(', ')}.` : '';
  if (outcome === 'O4') {
    return {
      buyerNote: `Dock rejected the goods: ${result.failed}.${refund}`,
      sellerNote: `Dock rejected the goods: ${result.failed}. Seller strike recorded.${returns}`,
    };
  }
  const why = result.failed ? ` (${result.failed})` : '';
  const extra = totals.excess ? ` ${totals.excess} extra boxes go back.` : '';
  return {
    buyerNote: `Goods checked at the dock: ${counted}${why}.${refund}`,
    sellerNote: `Goods checked: ${counted}${why}. ${result.voucherNumber}: ${formatRupees(result.acceptedValuePaise)} owed to the seller.${extra}${returns}`,
  };
}
