import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New entity, Q5b (6 Sep 2026) — not in DATA_MODEL.md's original ENT list;
 * added by this session per the client's answer and recorded in this
 * session's DATA_MODEL.md update. On a part rejection, **TriFid raises a
 * debit note to the seller for the rejected value** (the seller does not
 * raise a credit note). Blocks the seller's payout until raised
 * (dock.service.ts).
 *
 * M7 — `BR-183`'s hidden-defect claim raises a debit note the same way, but
 * after acceptance and payment, with no `Inspection` behind it at all (the
 * defect is by definition something outer-box inspection could not have
 * caught): `inspectionId` is optional and `complaintId` is the alternative
 * origin (`modules/controller`'s dispute decision).
 */
const debitNoteSchema = new Schema(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    sellerBillId: { type: Schema.Types.ObjectId, ref: 'SellerBill', required: true },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null },
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', default: null },
    rejectedValuePaise: { type: Number, required: true },
    raisedAt: { type: Date, required: true, default: () => new Date() },
    raisedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

debitNoteSchema.index({ poId: 1 });

export type DebitNoteDocument = InferSchemaType<typeof debitNoteSchema>;
export const DebitNote = model<DebitNoteDocument>('DebitNote', debitNoteSchema, 'debit_note');
