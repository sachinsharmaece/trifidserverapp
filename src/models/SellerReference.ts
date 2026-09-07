import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-07 `seller_reference`. BR-250 — two or more named referees captured
 * at registration; this record then lives permanently on the seller
 * master, not as a one-time gate — staff can add more later.
 */
const sellerReferenceSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    firm: { type: String, required: true },
    phone: { type: String, required: true },
    relationship: { type: String, required: true },
    whatTheySaid: { type: String, required: true },
    calledBy: { type: Schema.Types.ObjectId, default: null },
    calledAt: { type: Date, default: null },
    marketReputation: { type: String, default: null },
    assessedCapacityCasesPerMonth: { type: Number, default: null },
  },
  { timestamps: true },
);

sellerReferenceSchema.index({ sellerId: 1 });

export type SellerReferenceDocument = InferSchemaType<typeof sellerReferenceSchema>;
export const SellerReference = model<SellerReferenceDocument>(
  'SellerReference',
  sellerReferenceSchema,
  'seller_reference',
);
