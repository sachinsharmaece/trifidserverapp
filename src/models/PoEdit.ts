import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-31 `po_edit`. BR-036 — only `rate` or `qty` are ever editable on a PO,
 * every edit carries a reason and is visible on the document forever, and
 * **never after billing** (guarded in chain.service.ts `editPo`, not here —
 * a schema cannot see the parent PO's `billed` flag).
 */
const poEditSchema = new Schema(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    field: { type: String, enum: ['rate', 'qty'], required: true },
    from: { type: Number, required: true },
    to: { type: Number, required: true },
    reason: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

poEditSchema.index({ poId: 1, at: -1 });

export type PoEditDocument = InferSchemaType<typeof poEditSchema>;
export const PoEdit = model<PoEditDocument>('PoEdit', poEditSchema, 'po_edit');
