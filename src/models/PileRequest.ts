import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-22 `pile_request`. One row per buyer inquiry against a listing line
 * (WF-04). Nothing is charged and no clock runs against the seller while
 * these accumulate (BR-133).
 */
export const PILE_OFFER_STATES = ['offered', 'ordered', 'declined', 'expired'] as const;
export type PileOfferState = (typeof PILE_OFFER_STATES)[number];

const pileRequestSchema = new Schema(
  {
    pileId: { type: Schema.Types.ObjectId, ref: 'Pile', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    qty: { type: Number, required: true, min: 1 },
    // 29 Oct — null: his registered address. Buyers are approved with an address but no
    // delivery location (only staff add those, BR-094), so requiring one blocked every buy.
    deliveryLocationId: { type: Schema.Types.ObjectId, ref: 'BuyerLocation', default: null },
    requestedAt: { type: Date, required: true, default: () => new Date() },
    // DEC-051 — the enquiry this request is. Null only on requests made before it existed.
    enquiryId: { type: Schema.Types.ObjectId, ref: 'Enquiry', default: null },
    // 2 Nov — BR-378: once the seller confirms the pile, each buyer on it is given the deal (his
    // boxes, the expiry, his rate) and decides: his order is made when he accepts. `null` is a
    // request that has no deal given yet — or one from before this step existed, whose order was
    // made at the seller's confirmation. The boxes are held off the listing while `offered`.
    offerState: { type: String, enum: PILE_OFFER_STATES, default: null },
    offerQty: { type: Number, min: 1, default: null }, // May be fewer than asked: a short pile (BR-375).
    offeredAt: { type: Date, default: null },
    holdUntil: { type: Date, default: null }, // offeredAt + 24 h; then the boxes go back on the line.
  },
  { timestamps: true },
);

pileRequestSchema.index({ pileId: 1, requestedAt: 1 });
pileRequestSchema.index({ buyerId: 1 });
pileRequestSchema.index({ offerState: 1, holdUntil: 1 }); // The hold running out.

export type PileRequestDocument = InferSchemaType<typeof pileRequestSchema>;
export const PileRequest = model<PileRequestDocument>(
  'PileRequest',
  pileRequestSchema,
  'pile_request',
);
