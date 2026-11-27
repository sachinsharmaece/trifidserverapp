import { Schema, model } from 'mongoose';
import { VOUCHER_SOURCE_TYPES, VOUCHER_TYPES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_PAISE = 100_000_000_000; // ₹100 crore
/** One side of a voucher: a debit OR a credit on one ledger. */
const lineSchema = new Schema({
    ledgerId: { ...refField('Ledger'), required: true },
    /** The ledger's name when posted, so old vouchers read the same after a rename. */
    ledgerName: { ...textField(120), required: true },
    drPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
    crPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
}, { _id: false });
/**
 * A voucher: one money event in the double-entry books (SRS-ACC-01, ARCH B3.5). It has two or more lines; each
 * line is a debit or a credit (never both, never zero), and the debits equal the credits to the paisa.
 * Examples: a buyer's payment (RECEIPT RV-26-0001): Dr our bank ₹1,27,600 · Cr the buyer ₹1,27,600.
 * Goods accepted at the dock (PURCHASE PV-26-0001), ₹27,000 at 18% GST within MP: Dr Purchase ₹22,881.36 ·
 * Dr Input CGST ₹2,059.32 · Dr Input SGST ₹2,059.32 · Cr the seller ₹27,000.
 * The Marg bill to the buyer (SALES SV-26-0001): Dr the buyer · Cr Sales (taxable) · Cr Output CGST + SGST (or IGST).
 * Paying a seller (PAYMENT PY-26-0001): Dr the seller · Cr our bank (· Cr Freight for the freight we paid at Indore).
 * Refunding a buyer (PAYMENT): Dr the buyer · Cr our bank.
 * A credit note after a complaint (JOURNAL JV-26-0001): Dr Sales (taxable) · Dr Output GST · Cr the buyer.
 *
 * Posted vouchers are never changed or deleted (append-only, like audit_events). A mistake is undone later by a
 * mirror REVERSAL voucher. Only modules/books/books.ts writes vouchers (`postVoucher`).
 */
const voucherSchema = new Schema({
    number: { type: String, required: true, match: /^(RV|SV|PV|PY|JV|RX)-\d{2}-\d{4,}$/ },
    type: { type: String, enum: VOUCHER_TYPES, required: true },
    /** The business date, Indian time (YYYY-MM-DD): for a receipt, the day the money reached the bank. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    narration: { ...textField(300), required: true },
    /**
     * What the voucher was posted for: { type: 'RECEIPT', id, number: 'RCPT-26-0001' } or, for goods accepted at
     * the dock, { type: 'INSPECTION', id: the inspection, number: 'PO-26-0001' }.
     */
    source: {
        type: new Schema({
            type: {
                type: String,
                enum: VOUCHER_SOURCE_TYPES,
                required: true,
            },
            id: { type: Schema.Types.ObjectId, required: true },
            number: { type: String, required: true },
        }, { _id: false }),
        required: true,
    },
    lines: {
        type: [lineSchema],
        required: true,
        validate: {
            validator: (lines) => lines.length >= 2 &&
                lines.every((line) => line.drPaise > 0 !== line.crPaise > 0) &&
                lines.reduce((sum, line) => sum + line.drPaise - line.crPaise, 0) === 0,
            message: 'A voucher needs two or more lines, each a debit or a credit, and debits = credits',
        },
    },
    /** SALES and PURCHASE vouchers: the tax inside the total, for the registers and the GST summary. */
    gst: {
        type: new Schema({
            taxablePaise: { ...intField(0, MAX_PAISE), required: true },
            cgstPaise: { ...intField(0, MAX_PAISE), required: true },
            sgstPaise: { ...intField(0, MAX_PAISE), required: true },
            igstPaise: { ...intField(0, MAX_PAISE), required: true },
            taxBp: { ...intField(0, 10_000), required: true },
        }, { _id: false }),
        default: undefined,
    },
    /** Σ debits = Σ credits. */
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    createdBy: { ...refField('User'), required: true },
    postedAt: { type: Date, required: true },
}, { collection: 'vouchers', timestamps: true, versionKey: false });
voucherSchema.index({ number: 1 }, { unique: true });
// One automatic posting per event: a receipt can never be posted twice.
voucherSchema.index({ type: 1, 'source.type': 1, 'source.id': 1 }, { unique: true });
// A ledger's statement: its lines by date.
voucherSchema.index({ 'lines.ledgerId': 1, date: 1 });
// Append-only, like audit_events: the app may insert and read, never update or delete.
const appendOnly = () => {
    throw new Error('vouchers is append-only: updates and deletes are not allowed.');
};
voucherSchema.pre([
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
], appendOnly);
voucherSchema.pre('save', function () {
    if (!this.isNew)
        appendOnly();
});
export const VoucherModel = model('Voucher', voucherSchema);
//# sourceMappingURL=voucher.model.js.map