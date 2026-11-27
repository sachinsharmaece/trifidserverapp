import { Schema, model } from 'mongoose';
import { PAYOUT_BATCH_STATUSES, PAYOUT_LINE_STATUSES, PAYOUT_LINE_TYPES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_PAISE = 100_000_000_000; // ₹100 crore
/**
 * One payment inside a batch: a PAYOUT to a seller for a checked PO, or a REFUND to a buyer.
 * `grossPaise` is what we owe (the accepted value, or the refund); `freightPaise` is the freight we paid at Indore
 * that is taken off a seller's payout (0 for a refund); `amountPaise` = gross − freight is what leaves the bank.
 * The payee is copied here so the batch reads the same later.
 */
const lineSchema = new Schema({
    type: { type: String, enum: PAYOUT_LINE_TYPES, required: true },
    /** The PO (type PAYOUT) or the refund (type REFUND) being paid. */
    purchaseOrderId: refField('PurchaseOrder'),
    refundId: refField('Refund'),
    tradeId: { ...refField('Trade'), required: true },
    /** "PO-26-0001" or "REF-26-0001". */
    reference: { ...textField(30), required: true },
    payee: {
        type: new Schema({
            number: { type: String, required: true },
            firmName: { ...textField(200), required: true },
        }, { _id: false }),
        required: true,
    },
    grossPaise: { ...intField(1, MAX_PAISE), required: true },
    freightPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    status: { type: String, enum: PAYOUT_LINE_STATUSES, required: true, default: 'DRAFT' },
    /** The bank's proof that it was paid (Q-ACC-11: a line is PAID only when this is typed). */
    proof: {
        type: new Schema({
            utr: { type: String, required: true, match: /^[0-9A-Z]{6,30}$/ },
            paidOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
            by: { ...refField('User'), required: true },
            at: { type: Date, required: true },
        }, { _id: false }),
        default: undefined,
    },
    /** The PAYMENT voucher posted with the proof. */
    voucherId: refField('Voucher'),
});
/**
 * A payout batch (PAYB-26-0001, ARCH `payout_batches`): money going out of one of our bank accounts in one go.
 * DRAFT (Accounts built it) → RELEASED (Founder or Admin, not the builder, re-typed the password) → each line is
 * PAID when its UTR is typed. A DRAFT batch can be cancelled. The people pay at the bank themselves; the system
 * only records it (manual UTR entry, SRS-EXT-02).
 */
const payoutBatchSchema = new Schema({
    number: { type: String, required: true, match: /^PAYB-\d{2}-\d{4,}$/ },
    status: { type: String, enum: PAYOUT_BATCH_STATUSES, required: true, default: 'DRAFT' },
    /** The bank account (a ledger) the money leaves from. */
    bankLedgerId: { ...refField('Ledger'), required: true },
    lines: {
        type: [lineSchema],
        required: true,
        validate: {
            validator: (lines) => lines.length >= 1,
            message: 'A payout batch needs at least one line',
        },
    },
    /** Σ of the lines' `amountPaise`: what leaves the bank. */
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    createdBy: { ...refField('User'), required: true },
    releasedBy: refField('User'),
    releasedAt: Date,
    cancelledBy: refField('User'),
    cancelledAt: Date,
    version: { ...intField(0), required: true, default: 0 },
}, { collection: 'payout_batches', timestamps: true, versionKey: false });
payoutBatchSchema.index({ number: 1 }, { unique: true });
payoutBatchSchema.index({ status: 1, createdAt: -1 });
export const PayoutBatchModel = model('PayoutBatch', payoutBatchSchema);
//# sourceMappingURL=payoutBatch.model.js.map