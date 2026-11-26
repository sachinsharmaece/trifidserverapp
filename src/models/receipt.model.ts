import { Schema, model, type InferSchemaType } from 'mongoose';
import { RECEIPT_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/**
 * A payment the buyer says he made (an "Upcoming payment", SRS-PAY-01..03, ARCH B3.5 `receipts`).
 * Sales enters it at b6 (LOGGED: not money yet, nothing is posted). Accounts then finds it in the bank and
 * confirms it (POSTED: the RECEIPT voucher is written) or marks it not received (REJECTED).
 * Only the trade engine's payment actions write receipts (modules/payments/payments.ts).
 */
const receiptSchema = new Schema(
  {
    number: { type: String, required: true, match: /^RCPT-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    salesOrderId: { ...refField('SalesOrder'), required: true },
    /** Our bank account the money came into (a bank ledger). */
    bankLedgerId: { ...refField('Ledger'), required: true },
    /** The bank's transaction reference (UTR), as the buyer gave it. */
    utr: { type: String, required: true, match: /^[0-9A-Z]{6,30}$/ },
    /**
     * Same as `utr` while the receipt is LOGGED or POSTED, removed when REJECTED: a UTR is unique per bank
     * account among live receipts (SRS-PAY-03), and a rejected entry may be entered again correctly.
     */
    activeUtr: String,
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    /** The day the money reached our bank (Indian time), YYYY-MM-DD. */
    receivedOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: RECEIPT_STATUSES, required: true, default: 'LOGGED' },
    enteredBy: { ...refField('User'), required: true },
    enteredAt: { type: Date, required: true },
    /** Who confirmed it (never the person who entered it: maker ≠ checker) and the voucher written. */
    postedBy: refField('User'),
    postedAt: Date,
    voucherId: refField('Voucher'),
    /** Who marked it not received, and why. */
    rejectedBy: refField('User'),
    rejectedAt: Date,
    rejectNote: textField(300),
  },
  { collection: 'receipts', timestamps: true, versionKey: false },
);

receiptSchema.index({ number: 1 }, { unique: true });
receiptSchema.index(
  { bankLedgerId: 1, activeUtr: 1 },
  { unique: true, partialFilterExpression: { activeUtr: { $exists: true } } },
);
receiptSchema.index({ status: 1, enteredAt: 1 }); // the Accounts queue
receiptSchema.index({ salesOrderId: 1 });
receiptSchema.index({ tradeId: 1 });

export type Receipt = InferSchemaType<typeof receiptSchema>;
export const ReceiptModel = model('Receipt', receiptSchema);
