import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-03 `buyer_location`. BR-094 — added by staff on request only, never
 * self-serve. Additional locations carry **no tehsil** — visibility runs on
 * the primary tehsil (on `Buyer`) alone.
 */
const buyerLocationSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    label: { type: String, required: true },
    address: { type: String, required: true },
    pin: { type: String, required: true },
    preferredTransporter: { type: String },
    licenceNo: { type: String, required: true },
    approvedBy: { type: Schema.Types.ObjectId, required: true },
    approvedAt: { type: Date, required: true },
    isPrimary: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

buyerLocationSchema.index({ buyerId: 1 });

export type BuyerLocationDocument = InferSchemaType<typeof buyerLocationSchema>;
export const BuyerLocation = model<BuyerLocationDocument>(
  'BuyerLocation',
  buyerLocationSchema,
  'buyer_location',
);
