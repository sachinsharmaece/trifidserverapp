import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Staff-assisted enquiries, decision (B) — Accounts' own dedicated
 * confirmation of product and quantity received, separate from and in
 * addition to the dock's `Inspection` record (BR-182/BR-184). Mirrors
 * `Inspection`'s shape (one per PO, immutable once submitted — no update
 * route exists here either) rather than a field bolted onto `Po`, because
 * this is Accounts' own signed act, distinct from the dock's.
 */
const receiptConfirmationSchema = new Schema(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true, unique: true },
    productMatches: { type: Boolean, required: true },
    qtyMatches: { type: Boolean, required: true },
    notes: { type: String, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    confirmedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

export type ReceiptConfirmationDocument = InferSchemaType<typeof receiptConfirmationSchema>;
export const ReceiptConfirmation = model<ReceiptConfirmationDocument>(
  'ReceiptConfirmation',
  receiptConfirmationSchema,
  'receipt_confirmation',
);
