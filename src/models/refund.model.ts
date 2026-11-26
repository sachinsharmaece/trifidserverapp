import { Schema, model, type InferSchemaType } from 'mongoose';
import { REFUND_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/**
 * Money we owe a buyer back (REF-26-0001): boxes the dock found short, damaged or leaking, at the buyer's rate
 * on his sales order (LOCK-40 A2, BR-38). Buyer side of the wall: it holds our selling price.
 *
 * Only recorded as DUE for now. Paying it (to the account the money came from, a PAYMENT voucher Dr Buyer · Cr
 * Bank, BR-42) comes with payouts, which wait on Q-ACC-11/12.
 */
const refundSchema = new Schema(
  {
    number: { type: String, required: true, match: /^REF-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    salesOrderId: { ...refField('SalesOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    /** What it is for, e.g. "Dock: 2 boxes short, 1 damaged (PO-26-0004)" (no seller name). */
    reason: { ...textField(300), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true, default: 'DUE' },
    createdBy: { ...refField('User'), required: true },
  },
  { collection: 'refunds', timestamps: true, versionKey: false },
);

refundSchema.index({ number: 1 }, { unique: true });
refundSchema.index({ salesOrderId: 1 });
refundSchema.index({ status: 1, createdAt: 1 });

export type Refund = InferSchemaType<typeof refundSchema>;
export const RefundModel = model('Refund', refundSchema);
