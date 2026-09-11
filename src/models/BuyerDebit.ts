import { Schema, model, type InferSchemaType } from 'mongoose';

/** ENT-38, buyer side. See models/SellerDebit.ts for the full note. */
const buyerDebitSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    amountPaise: { type: Number, required: true },
    reason: { type: String, required: true },
    nettedAgainst: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

buyerDebitSchema.index({ counterpartyId: 1, nettedAgainst: 1 });

export type BuyerDebitDocument = InferSchemaType<typeof buyerDebitSchema>;
export const BuyerDebit = model<BuyerDebitDocument>('BuyerDebit', buyerDebitSchema, 'buyer_debit');
