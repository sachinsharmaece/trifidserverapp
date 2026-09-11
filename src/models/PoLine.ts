import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-30 `po_line`. `sellerNetPaise` is copied from the paired `so_line`'s
 * frozen `sellerNetPaise` at PO-creation time (chain.service.ts `createPo`)
 * — never re-read from the seller's current listing, for the same
 * frozen-price reasoning as BR-045.
 */
const poLineSchema = new Schema(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', required: true },
    boxes: { type: Number, required: true, min: 1 },
    sellerNetPaise: { type: Number, required: true },
  },
  { timestamps: true },
);

poLineSchema.index({ poId: 1 });

export type PoLineDocument = InferSchemaType<typeof poLineSchema>;
export const PoLine = model<PoLineDocument>('PoLine', poLineSchema, 'po_line');
