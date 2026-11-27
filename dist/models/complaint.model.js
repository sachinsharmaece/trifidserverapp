import { Schema, model } from 'mongoose';
import { COMPLAINT_CATEGORIES, COMPLAINT_OUTCOMES, COMPLAINT_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_PAISE = 100_000_000_000; // ₹100 crore
/**
 * A buyer's complaint about goods he received (CMP-26-0001), raised by Sales within the delivery window (7 days
 * after the proof of dispatch) and decided by the Controller (SRS §6.4, Q-SAL-05 and Q-SAL-08 defaults).
 * One model for the funnel stage (b11) and the order's dispute: the trade is at b11 while the complaint is OPEN.
 *
 * Buyer side of the wall: it names the buyer and, for a credit or refund, our selling price. Never the seller.
 * Raised and resolved ONLY by the trade engine (`raiseComplaint`, `resolveComplaint`), in its transaction.
 */
const complaintSchema = new Schema({
    number: { type: String, required: true, match: /^CMP-\d{2}-\d{4,}$/ },
    tradeId: { ...refField('Trade'), required: true },
    salesOrderId: { ...refField('SalesOrder'), required: true },
    buyerId: { ...refField('Buyer'), required: true },
    status: { type: String, enum: COMPLAINT_STATUSES, required: true, default: 'OPEN' },
    /** Where the trade was when he complained: b9 (before delivery was confirmed) or b10. */
    raisedAtStage: { type: String, enum: ['B9_DISPATCH', 'B10_DELIVERED'], required: true },
    category: { type: String, enum: COMPLAINT_CATEGORIES, required: true },
    reasonCodeId: { ...refField('ReasonCode'), required: true },
    /** The reason's words when it was picked, so the record reads the same if the code is renamed. */
    reasonLabel: { ...textField(120), required: true },
    description: textField(500),
    /** Boxes the buyer says are affected (optional). */
    boxes: intField(1, 1_000_000),
    raisedBy: { ...refField('User'), required: true },
    raisedAt: { type: Date, required: true },
    /** The Controller is due to decide by then (SLA_B11_HOURS). */
    resolveByAt: { type: Date, required: true },
    resolution: {
        type: new Schema({
            outcome: { type: String, enum: COMPLAINT_OUTCOMES, required: true },
            /** CREDIT and REFUND only: the money, tax included. */
            amountPaise: intField(1, MAX_PAISE),
            /** REFUND, REPLACEMENT, RETURN: how many boxes. */
            boxes: intField(1, 1_000_000),
            /** What the Controller decided and why. Sales reads it, so it never names the seller. */
            note: { ...textField(500), required: true },
            /** REFUND: the refund that now waits for a payout batch. */
            refundId: refField('Refund'),
            /** CREDIT and REFUND: the credit note posted to the buyer's ledger (JV-26-0001). */
            voucherId: refField('Voucher'),
            byUserId: { ...refField('User'), required: true },
            at: { type: Date, required: true },
        }, { _id: false }),
        default: undefined,
    },
}, { collection: 'complaints', timestamps: true, versionKey: false });
complaintSchema.index({ number: 1 }, { unique: true });
complaintSchema.index({ tradeId: 1, createdAt: 1 });
complaintSchema.index({ salesOrderId: 1 });
complaintSchema.index({ status: 1, raisedAt: 1 });
export const ComplaintModel = model('Complaint', complaintSchema);
//# sourceMappingURL=complaint.model.js.map