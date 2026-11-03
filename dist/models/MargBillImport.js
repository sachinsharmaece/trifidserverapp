import { Schema, model } from 'mongoose';
/**
 * LOCK-34 `marg_bill_import`. A bill from before go-live, loaded from Marg's
 * history (`npm run import:margBills`). It only feeds a party's billing clock;
 * it is not an order and nothing else reads it. Money is in paise, like every
 * other amount here.
 *
 * `invoiceKey` is the invoice number trimmed and upper-cased. Together with the
 * bill date it is unique, so a re-run adds nothing twice (invoice numbers can
 * repeat across financial years, so the number alone is not enough).
 */
const margBillImportSchema = new Schema({
    gstin: { type: String, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    invoiceNo: { type: String, required: true },
    invoiceKey: { type: String, required: true },
    billDate: { type: Date, required: true },
    netPaise: { type: Number, required: true },
    importedAt: { type: Date, required: true, default: () => new Date() },
}, { timestamps: true });
margBillImportSchema.index({ invoiceKey: 1, billDate: 1 }, { unique: true });
margBillImportSchema.index({ partyId: 1 });
export const MargBillImport = model('MargBillImport', margBillImportSchema, 'marg_bill_import');
