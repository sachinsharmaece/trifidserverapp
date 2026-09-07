import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-08 `seller_block`. BR-089/BR-090 — a seller excludes a named buyer by
 * GSTIN. **Deliberately no `reason` field and no `requestedBy` field** — who
 * asked for it is never stored, not even as a convenience for support. Cap
 * 20 per seller, enforced in the service layer (BR-089).
 */
const sellerBlockSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    gstin: { type: String, required: true },
    addedByStaffId: { type: Schema.Types.ObjectId, required: true },
    addedAt: { type: Date, required: true },
    status: { type: String, enum: ['active', 'removed'], required: true, default: 'active' },
  },
  { timestamps: true },
);

sellerBlockSchema.index({ sellerId: 1, gstin: 1 }, { unique: true });

export type SellerBlockDocument = InferSchemaType<typeof sellerBlockSchema>;
export const SellerBlock = model<SellerBlockDocument>(
  'SellerBlock',
  sellerBlockSchema,
  'seller_block',
);
