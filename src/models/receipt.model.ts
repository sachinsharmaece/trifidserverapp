import { Schema, model, type InferSchemaType } from 'mongoose';
import { RECEIPT_SOURCES, RECEIPT_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/** One use of a POSTED payment: this much went to this order (`paidPaise`). The rest is an advance on the buyer's account. */
const allocationSchema = new Schema(
  {
    salesOrderId: { ...refField('SalesOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
  },
  { _id: false },
);

/**
 * A payment the buyer made (an "Upcoming payment", SRS-PAY-01..03, ARCH B3.5 `receipts`).
 * Sales enters it at b6 against an order (source SALES_ENTRY), or Accounts adds it by hand when money reached the
 * bank with no order (source HAND_ADDED, no `salesOrderId`). Either way it is LOGGED first (not money yet, nothing
 * is posted); a DIFFERENT person finds it in the bank and posts it (POSTED: the RECEIPT voucher is written) or marks
 * it not received (REJECTED). A posted payment is spent on orders through `allocations`; what is not spent is an
 * advance on the buyer's account (Build 9). A wrong hand-added one that is still unspent can be REVERSED.
 * Only modules/payments writes receipts. A payment POSTED before Build 9 has no `allocations`: it was spent in full
 * on its own order (`allocationsOf` in modules/payments/advances.ts reads it that way).
 */
const receiptSchema = new Schema(
  {
    number: { type: String, required: true, match: /^RCPT-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    /** The order it was entered against. Not set on a hand-added payment (it is an advance until spent). */
    tradeId: refField('Trade'),
    salesOrderId: refField('SalesOrder'),
    source: { type: String, enum: RECEIPT_SOURCES, required: true, default: 'SALES_ENTRY' },
    /** Hand-added: what the money was for, in the person's words. */
    note: textField(300),
    allocations: { type: [allocationSchema], default: [] },
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
    /** Who reversed it (a REVERSAL voucher mirrors the RECEIPT voucher), when, and why. */
    reversedBy: refField('User'),
    reversedAt: Date,
    reverseVoucherId: refField('Voucher'),
    reverseNote: textField(300),
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
receiptSchema.index({ buyerId: 1, status: 1 }); // a buyer's advances

export type Receipt = InferSchemaType<typeof receiptSchema>;
export const ReceiptModel = model('Receipt', receiptSchema);
