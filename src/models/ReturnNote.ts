import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-41 `return_note`. BR-189 — rejected cases stay at the dock under this
 * document, 30 days, seller bears return freight. "Written off" is not
 * available for this category. ⚠️ Day 31 is open — QR-021; this milestone
 * only raises the note and starts the clock (`dueBy`), it does not
 * implement what happens if `returnedAt` is still null past `dueBy`.
 */
const returnNoteSchema = new Schema(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    cases: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    photoRefs: [{ type: String }],
    raisedAt: { type: Date, required: true, default: () => new Date() },
    dueBy: { type: Date, required: true },
    returnedAt: { type: Date, default: null },
    freightDebited: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

returnNoteSchema.index({ poId: 1 });
returnNoteSchema.index({ returnedAt: 1, dueBy: 1 });

export type ReturnNoteDocument = InferSchemaType<typeof returnNoteSchema>;
export const ReturnNote = model<ReturnNoteDocument>('ReturnNote', returnNoteSchema, 'return_note');
