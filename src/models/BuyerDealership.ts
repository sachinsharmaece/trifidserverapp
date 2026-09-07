import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-04 `buyer_dealership`. BR-244 — supply intelligence, not price and
 * not a filter. Products of a company he holds a dealership for are not
 * hidden from him.
 */
const buyerDealershipSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    manufacturerId: { type: Schema.Types.ObjectId, ref: 'Manufacturer', required: true },
    isStrong: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

buyerDealershipSchema.index({ buyerId: 1, manufacturerId: 1 }, { unique: true });

export type BuyerDealershipDocument = InferSchemaType<typeof buyerDealershipSchema>;
export const BuyerDealership = model<BuyerDealershipDocument>(
  'BuyerDealership',
  buyerDealershipSchema,
  'buyer_dealership',
);
