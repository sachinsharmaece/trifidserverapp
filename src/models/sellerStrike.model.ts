import { Schema, model, type InferSchemaType } from 'mongoose';
import { refField } from './_fields.js';

/**
 * A strike against a seller (SRS-LOG-04): the dock accepted none of his goods (LOCK-40 O4). Lost in transit (O8)
 * will add a second kind. Only recorded for now: what strikes lead to is still open (Q-PUR-08).
 */
const sellerStrikeSchema = new Schema(
  {
    sellerId: { ...refField('Seller'), required: true },
    purchaseOrderId: { ...refField('PurchaseOrder'), required: true },
    kind: { type: String, enum: ['DOCK_REJECTED'], required: true },
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
  },
  { collection: 'seller_strikes', timestamps: true, versionKey: false },
);

sellerStrikeSchema.index({ sellerId: 1, at: -1 });

export type SellerStrike = InferSchemaType<typeof sellerStrikeSchema>;
export const SellerStrikeModel = model('SellerStrike', sellerStrikeSchema);
