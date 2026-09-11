import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-38 `seller_debit` / `buyer_debit`. BR-022 — debit ledgers on both
 * sides, netted at payout (seller) or against a refund (buyer). One
 * collection per side, same shape, so the two are never accidentally
 * summed together.
 */
const sellerDebitSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    amountPaise: { type: Number, required: true },
    reason: { type: String, required: true },
    nettedAgainst: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

sellerDebitSchema.index({ counterpartyId: 1, nettedAgainst: 1 });

export type SellerDebitDocument = InferSchemaType<typeof sellerDebitSchema>;
export const SellerDebit = model<SellerDebitDocument>(
  'SellerDebit',
  sellerDebitSchema,
  'seller_debit',
);
