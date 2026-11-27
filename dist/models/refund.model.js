import { Schema, model } from 'mongoose';
import { REFUND_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_PAISE = 100_000_000_000; // ₹100 crore
/**
 * Money we owe a buyer back (REF-26-0001): boxes the dock found short, damaged or leaking, or boxes a complaint's
 * outcome refunds (Build 6), at the buyer's rate on his sales order (LOCK-40 A2, BR-38). Buyer side of the wall:
 * it holds our selling price.
 *
 * It is DUE until a payout batch pays it (to the account the money came from; the PAYMENT voucher is Dr Buyer ·
 * Cr Bank, BR-42), then PAID. The UTR and date live on the batch line.
 */
const refundSchema = new Schema({
    number: { type: String, required: true, match: /^REF-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    salesOrderId: { ...refField('SalesOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    /** What it is for, e.g. "Dock: 2 boxes short, 1 damaged (PO-26-0004)" (no seller name). */
    reason: { ...textField(300), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    /** Set when a complaint's outcome created it (Build 6); a dock refund has none. */
    complaintId: refField('Complaint'),
    status: { type: String, enum: REFUND_STATUSES, required: true, default: 'DUE' },
    /** The payout batch that is paying it (set while the batch is live, kept once paid; cleared if it is cancelled). */
    payoutBatchId: refField('PayoutBatch'),
    paidAt: Date,
    /** A dock correction replaced it before it was paid (status CANCELLED, Build 9). */
    cancelledAt: Date,
    createdBy: { ...refField('User'), required: true },
}, { collection: 'refunds', timestamps: true, versionKey: false });
refundSchema.index({ number: 1 }, { unique: true });
refundSchema.index({ salesOrderId: 1 });
refundSchema.index({ complaintId: 1 }, { sparse: true });
refundSchema.index({ status: 1, createdAt: 1 });
export const RefundModel = model('Refund', refundSchema);
//# sourceMappingURL=refund.model.js.map