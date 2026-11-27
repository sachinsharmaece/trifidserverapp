import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { numberSetting } from '../../db/settings.js';
import {
  BuyerModel,
  ComplaintModel,
  RefundModel,
  SalesOrderModel,
  UserModel,
  VoucherModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { COMPLAINT_CATEGORIES, type ComplaintCategory } from '../../shared/enums.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees, splitGst } from '../../shared/money.js';
import { buyerLedger, postVoucher, systemLedger } from '../books/books.js';
import { reasonFor } from '../masters/reasons.js';
import { objectId } from '../parties/common.js';
import { istDate } from '../payments/payments.js';
import { billedBoxes } from '../trips/trips.js';
import type { CommandContext } from '../trades/commands.js';

/**
 * Complaints after dispatch (SRS §6.4, FR-LOG-03). Defaults for the open questions, decided in Build 6 and easy to
 * change here:
 *   Q-SAL-05  one complaint model; the outcomes are NO_ACTION, CREDIT, REPLACEMENT, RETURN and REFUND
 *   Q-SAL-08  a complaint may come at b9 (before delivery is confirmed) or b10, inside the delivery window (7 days
 *             after the proof of dispatch), with a category and a reason, and the Controller always records an outcome
 *
 * `raiseComplaint` (Sales) opens a complaint and moves the trade to b11. `resolveComplaint` (Controller) closes it
 * and moves the trade to b10. Both are engine actions: the functions here run inside the engine's transaction.
 *
 * Money: a CREDIT or a REFUND posts a credit note (a JOURNAL voucher, JV-yy-0001): Dr Sales · Dr Output GST · Cr the
 * buyer, so the sale is reduced. A REFUND then also makes a refund line (REF-) that waits for a payout batch, whose
 * proof posts Dr buyer · Cr bank: the buyer's ledger is square again. REPLACEMENT and RETURN are recorded decisions:
 * the stock side of both (a new dispatch, a pickup) comes with a later build.
 */

export const COMPLAINT_CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  DAMAGE_ON_ARRIVAL: 'Damaged on arrival',
  SHORTAGE: 'Boxes short',
  WRONG_ITEM: 'Wrong item',
  QUALITY_COMPLAINT: 'Quality complaint',
  OTHER: 'Other',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_PAISE = 100_000_000_000;

/** History notes hold 300 characters at most. */
const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 297)}...` : text);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((text) => text || undefined);

// ---------------------------------------------------------------------------------------------------------------
// Raise

export const raiseInput = z.object({
  category: z.enum(COMPLAINT_CATEGORIES, 'Choose what the complaint is about'),
  reasonCodeId: objectId,
  description: optionalText(500),
  boxes: z
    .number()
    .int('Enter a whole number of boxes')
    .min(1, 'Enter at least 1 box')
    .max(1_000_000)
    .optional(),
});

/** The last moment the buyer may complain: fixed at the proof of dispatch (older trades: dispatch + the setting). */
async function windowEnd(
  trade: CommandContext['trade'],
  order: { dispatchedAt?: Date | null | undefined },
  now: Date,
) {
  if (trade.complaintByAt) return trade.complaintByAt;
  const days = await numberSetting('DELIVERY_WINDOW_DAYS', 7);
  return new Date((order.dispatchedAt ?? now).getTime() + days * DAY_MS);
}

/** Opens a complaint on the trade (the engine then moves it to b11 and starts the Controller's clock). */
export async function raiseComplaint(ctx: CommandContext, input: z.output<typeof raiseInput>) {
  const { req, trade, userId, now, session } = ctx;
  const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
  const endsAt = await windowEnd(trade, order, now);
  if (now > endsAt) {
    throw conflict(
      `The complaint window ended on ${istDate(endsAt)}: the buyer can no longer complain on this order.`,
      'COMPLAINT_WINDOW_OVER',
    );
  }
  const reason = await reasonFor(input.reasonCodeId, 'COMPLAINT');
  const billed = billedBoxes(order);
  if (input.boxes && input.boxes > billed) {
    throw invalidField('boxes', `Only ${billed} boxes were billed on this order.`);
  }
  const hours = await numberSetting('SLA_B11_HOURS', 48);
  const resolveByAt = new Date(now.getTime() + hours * HOUR_MS);

  const [complaint] = await ComplaintModel.create(
    [
      {
        number: await nextDocumentNumber('CMP', { session, at: now }),
        tradeId: trade._id,
        salesOrderId: order._id,
        buyerId: order.buyerId,
        status: 'OPEN',
        raisedAtStage: trade.buyerStage === 'B9_DISPATCH' ? 'B9_DISPATCH' : 'B10_DELIVERED',
        category: input.category,
        reasonCodeId: reason._id,
        reasonLabel: reason.label,
        ...(input.description ? { description: input.description } : {}),
        ...(input.boxes ? { boxes: input.boxes } : {}),
        raisedBy: userId,
        raisedAt: now,
        resolveByAt,
      },
    ],
    { session },
  );
  if (!complaint) throw new Error('The complaint was not created');
  await writeAudit(req, {
    action: 'complaint.raise',
    entityType: 'Complaint',
    entityId: complaint.id,
    after: {
      number: complaint.number,
      salesOrder: order.number,
      category: complaint.category,
      reason: reason.label,
    },
    session,
  });
  return {
    resolveByAt,
    note: clip(
      `Complaint ${complaint.number}: ${COMPLAINT_CATEGORY_LABELS[input.category]}, ${reason.label}${input.description ? ` (${input.description})` : ''}`,
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Resolve

const note = z.string().trim().min(1, 'Write what was decided and why.').max(500);
const boxCount = z
  .number('Enter the number of boxes')
  .int('Enter a whole number of boxes')
  .min(1, 'Enter at least 1 box')
  .max(1_000_000);

export const resolveInput = z.discriminatedUnion(
  'outcome',
  [
    z.object({ outcome: z.literal('NO_ACTION'), note }),
    z.object({
      outcome: z.literal('CREDIT'),
      amountPaise: z
        .number('Enter the credit amount')
        .int()
        .min(1, 'Enter the credit amount')
        .max(MAX_PAISE),
      note,
    }),
    z.object({ outcome: z.literal('REPLACEMENT'), boxes: boxCount, note }),
    z.object({ outcome: z.literal('RETURN'), boxes: boxCount, note }),
    z.object({ outcome: z.literal('REFUND'), boxes: boxCount, note }),
  ],
  'Choose what is decided',
);

/** What earlier complaints on this order already gave back: money (credits and refunds) and refunded boxes. */
async function decidedSoFar(salesOrderId: Types.ObjectId, session: ClientSession) {
  const done = await ComplaintModel.find({ salesOrderId, status: 'RESOLVED' }).session(session);
  return {
    moneyPaise: done.reduce((sum, item) => sum + (item.resolution?.amountPaise ?? 0), 0),
    refundedBoxes: done.reduce(
      (sum, item) =>
        sum + (item.resolution?.outcome === 'REFUND' ? (item.resolution.boxes ?? 0) : 0),
      0,
    ),
  };
}

/**
 * The credit note: a JOURNAL voucher that reduces the sale and the buyer's debt by `amountPaise` (tax inside).
 * Dr Sales (taxable) · Dr Output CGST + SGST (or IGST) · Cr the buyer. One per complaint (unique per source).
 */
async function postCreditNote(
  ctx: CommandContext,
  complaint: { _id: Types.ObjectId; number: string },
  order: {
    buyerId: Types.ObjectId;
    number: string;
    interState: boolean;
    lines: { taxBp: number }[];
  },
  amountPaise: number,
) {
  const { req, userId, now, session } = ctx;
  const buyer = await BuyerModel.findById(order.buyerId).session(session).orFail();
  const taxBp = order.lines[0]!.taxBp;
  const gst = splitGst(amountPaise, taxBp, order.interState);
  const taxLines = order.interState
    ? [{ ledger: await systemLedger('OUTPUT_IGST', userId, session), drPaise: gst.igstPaise }]
    : [
        { ledger: await systemLedger('OUTPUT_CGST', userId, session), drPaise: gst.cgstPaise },
        { ledger: await systemLedger('OUTPUT_SGST', userId, session), drPaise: gst.sgstPaise },
      ];
  return postVoucher(
    req,
    {
      type: 'JOURNAL',
      date: istDate(now),
      narration: `Credit note for complaint ${complaint.number} (${order.number})`,
      source: { type: 'COMPLAINT', id: complaint._id, number: complaint.number },
      lines: [
        { ledger: await systemLedger('SALES', userId, session), drPaise: gst.taxablePaise },
        ...taxLines.filter((line) => line.drPaise > 0),
        { ledger: await buyerLedger(buyer, userId, session), crPaise: amountPaise },
      ],
      gst: { ...gst, taxBp },
      userId,
      now,
    },
    session,
  );
}

/**
 * The Controller's decision. Closes the open complaint, posts the credit note for a CREDIT or REFUND, and for a
 * REFUND makes the refund line that Accounts then puts in a payout batch. Returns the buyer's note for the history.
 */
export async function resolveComplaint(ctx: CommandContext, input: z.output<typeof resolveInput>) {
  const { req, trade, userId, now, session } = ctx;
  const complaint = await ComplaintModel.findOne({ tradeId: trade._id, status: 'OPEN' }).session(
    session,
  );
  if (!complaint) throw conflict('There is no open complaint on this trade.', 'NO_OPEN_COMPLAINT');
  const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
  const line = order.lines[0]!;
  const billed = billedBoxes(order);
  const decided = await decidedSoFar(order._id, session);
  const leftPaise = (order.margBill?.totalPaise ?? 0) - decided.moneyPaise;

  // What the decision is worth, checked against what was billed and what earlier complaints already gave back.
  let amountPaise = 0;
  let boxes = 0;
  if (input.outcome === 'CREDIT') {
    amountPaise = input.amountPaise;
    if (amountPaise > leftPaise) {
      throw invalidField(
        'amountPaise',
        `The most that can still be credited is ${formatRupees(Math.max(leftPaise, 0))}: the order was billed at ${formatRupees(order.margBill?.totalPaise ?? 0)}.`,
      );
    }
  } else if (input.outcome !== 'NO_ACTION') {
    boxes = input.boxes;
    if (boxes > billed)
      throw invalidField('boxes', `Only ${billed} boxes were billed on this order.`);
    if (input.outcome === 'REFUND') {
      if (boxes > billed - decided.refundedBoxes) {
        throw invalidField(
          'boxes',
          `Only ${billed - decided.refundedBoxes} boxes can still be refunded: earlier complaints refunded ${decided.refundedBoxes}.`,
        );
      }
      amountPaise = boxes * line.unitsPerBox * line.buyerRatePaisePerUnit;
      if (amountPaise > leftPaise) {
        throw invalidField(
          'boxes',
          `That refund is ${formatRupees(amountPaise)} but only ${formatRupees(Math.max(leftPaise, 0))} can still be given back on this order.`,
        );
      }
    }
  }

  const voucher = amountPaise > 0 ? await postCreditNote(ctx, complaint, order, amountPaise) : null;
  let refund = null;
  if (input.outcome === 'REFUND') {
    const [saved] = await RefundModel.create(
      [
        {
          number: await nextDocumentNumber('REF', { session, at: now }),
          buyerId: order.buyerId,
          salesOrderId: order._id,
          tradeId: trade._id,
          complaintId: complaint._id,
          reason: `Complaint ${complaint.number}: ${boxes} boxes (${order.number})`,
          boxes,
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
      after: { number: saved.number, amountPaise, complaint: complaint.number },
      session,
    });
    refund = saved;
  }

  const result = await ComplaintModel.updateOne(
    { _id: complaint._id, status: 'OPEN' },
    {
      $set: {
        status: 'RESOLVED',
        resolution: {
          outcome: input.outcome,
          ...(amountPaise > 0 ? { amountPaise } : {}),
          ...(boxes > 0 ? { boxes } : {}),
          note: input.note,
          ...(refund ? { refundId: refund._id } : {}),
          ...(voucher ? { voucherId: voucher._id } : {}),
          byUserId: userId,
          at: now,
        },
      },
    },
    { session, runValidators: true },
  );
  if (result.matchedCount !== 1) {
    throw conflict('Someone else resolved this complaint.', 'NO_OPEN_COMPLAINT');
  }
  await writeAudit(req, {
    action: 'complaint.resolve',
    entityType: 'Complaint',
    entityId: complaint.id,
    before: { status: 'OPEN' },
    after: {
      status: 'RESOLVED',
      outcome: input.outcome,
      ...(amountPaise > 0 ? { amountPaise } : {}),
      ...(voucher ? { creditNote: voucher.number } : {}),
      ...(refund ? { refund: refund.number } : {}),
    },
    session,
  });

  const decision: Record<typeof input.outcome, string> = {
    NO_ACTION: 'no action',
    CREDIT: `${formatRupees(amountPaise)} credited to the buyer${voucher ? ` (${voucher.number})` : ''}`,
    REFUND: `${boxes} boxes refunded, ${formatRupees(amountPaise)}${refund ? ` (${refund.number}, waiting for a payout)` : ''}${voucher ? `, credit note ${voucher.number}` : ''}`,
    REPLACEMENT: `${boxes} boxes to be replaced`,
    RETURN: `${boxes} boxes to be returned`,
  };
  return {
    // A complaint raised before delivery was confirmed also ends the wait: the goods are with the buyer.
    deliver: complaint.raisedAtStage === 'B9_DISPATCH' && order.status === 'DISPATCHED',
    note: clip(`Complaint ${complaint.number} resolved: ${decision[input.outcome]}. ${input.note}`),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Views (buyer side of the wall: no seller, ever)

type ComplaintDoc = InstanceType<typeof ComplaintModel>;

/** Complaints as the cards and lists show them: names of people, the refund and credit note numbers. */
export async function complaintViews(complaints: ComplaintDoc[]) {
  const userIds = complaints.flatMap((item) =>
    item.resolution ? [item.raisedBy, item.resolution.byUserId] : [item.raisedBy],
  );
  const users = await UserModel.find({ _id: { $in: userIds } }, { name: 1 });
  const refunds = await RefundModel.find(
    {
      _id: {
        $in: complaints.flatMap((item) =>
          item.resolution?.refundId ? [item.resolution.refundId] : [],
        ),
      },
    },
    { number: 1, status: 1 },
  );
  const vouchers = await VoucherModel.find(
    {
      _id: {
        $in: complaints.flatMap((item) =>
          item.resolution?.voucherId ? [item.resolution.voucherId] : [],
        ),
      },
    },
    { number: 1 },
  );
  const nameOf = (id: Types.ObjectId) => users.find((user) => user._id.equals(id))?.name ?? '';
  return complaints.map((item) => {
    const done = item.resolution;
    const refundId = done?.refundId;
    const voucherId = done?.voucherId;
    const refund = refundId ? refunds.find((r) => r._id.equals(refundId)) : undefined;
    const voucher = voucherId ? vouchers.find((v) => v._id.equals(voucherId)) : undefined;
    return {
      id: item.id,
      number: item.number,
      status: item.status,
      raisedAtStage: item.raisedAtStage,
      category: item.category,
      reasonLabel: item.reasonLabel,
      description: item.description ?? null,
      boxes: item.boxes ?? null,
      raisedAt: item.raisedAt,
      raisedBy: nameOf(item.raisedBy),
      resolveByAt: item.resolveByAt,
      /** Open and past the time the Controller was given. */
      overdue: item.status === 'OPEN' && item.resolveByAt.getTime() < Date.now(),
      resolution: done
        ? {
            outcome: done.outcome,
            amountPaise: done.amountPaise ?? null,
            boxes: done.boxes ?? null,
            note: done.note,
            refundNumber: refund?.number ?? null,
            refundStatus: refund?.status ?? null,
            creditNoteNumber: voucher?.number ?? null,
            at: done.at,
            by: nameOf(done.byUserId),
          }
        : null,
    };
  });
}

/** The complaints on one trade or sales order, oldest first. */
export async function complaintsOf(
  filter: { tradeId: Types.ObjectId } | { salesOrderId: Types.ObjectId },
) {
  const found = await ComplaintModel.find(filter).sort({ raisedAt: 1 });
  return complaintViews(found);
}
