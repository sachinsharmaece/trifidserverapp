import { Schema, model } from 'mongoose';
/** ENT-38, buyer side. See models/SellerDebit.ts for the full note. */
const buyerDebitSchema = new Schema({
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    amountPaise: { type: Number, required: true },
    reason: { type: String, required: true },
    nettedAgainst: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: true });
buyerDebitSchema.index({ counterpartyId: 1, nettedAgainst: 1 });
export const BuyerDebit = model('BuyerDebit', buyerDebitSchema, 'buyer_debit');
