import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-22 `pile_request`. One row per buyer inquiry against a listing line
 * (WF-04). Nothing is charged and no clock runs against the seller while
 * these accumulate (BR-133).
 */
const pileRequestSchema = new Schema(
  {
    pileId: { type: Schema.Types.ObjectId, ref: 'Pile', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    qty: { type: Number, required: true, min: 1 },
    deliveryLocationId: { type: Schema.Types.ObjectId, ref: 'BuyerLocation', required: true },
    requestedAt: { type: Date, required: true, default: () => new Date() },
    // DEC-051 — the enquiry this request is. Null only on requests made before it existed.
    enquiryId: { type: Schema.Types.ObjectId, ref: 'Enquiry', default: null },
  },
  { timestamps: true },
);

pileRequestSchema.index({ pileId: 1, requestedAt: 1 });
pileRequestSchema.index({ buyerId: 1 });

export type PileRequestDocument = InferSchemaType<typeof pileRequestSchema>;
export const PileRequest = model<PileRequestDocument>(
  'PileRequest',
  pileRequestSchema,
  'pile_request',
);
