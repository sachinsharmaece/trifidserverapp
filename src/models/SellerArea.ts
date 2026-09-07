import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-06 `seller_area`. BR-082 — a seller's area is a tehsil set, set once
 * at onboarding by Purchase staff. He has no edit rights over it.
 * `{tehsilId}` is indexed on its own because it is the resolver's hot path
 * (BR-080) — every visibility check walks from a buyer's tehsil outward.
 */
const sellerAreaSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    tehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', required: true },
    setBy: { type: Schema.Types.ObjectId, required: true },
    setAt: { type: Date, required: true },
  },
  { timestamps: true },
);

sellerAreaSchema.index({ sellerId: 1, tehsilId: 1 }, { unique: true });
sellerAreaSchema.index({ tehsilId: 1 });

export type SellerAreaDocument = InferSchemaType<typeof sellerAreaSchema>;
export const SellerArea = model<SellerAreaDocument>('SellerArea', sellerAreaSchema, 'seller_area');
