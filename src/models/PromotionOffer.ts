import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New entity — WF-11's fallback/absorption workflow. Not in `DATA_MODEL.md`'s
 * original ENT list; added this session (M6) alongside the WF-11 build, see
 * `CHANGELOG.md`. Recorded whenever a seller's supply failure has a live,
 * affordable replacement: the buyer's own price never moves (`so.totalPaise`
 * is untouched), but a *different* seller's stock is not what he agreed to,
 * so he gets a 24-hour say (`IC-14`) before it becomes real.
 *
 * `deltaPaise`/`withinCap` are exactly what `IC-06` allows a Purchase
 * response to carry — never `capPaise`, never the two source rates. Both are
 * kept here (server-side) for the desk to reason about; the DTO layer omits
 * `capPaise` and the two seller rates on every Purchase-facing projection.
 */
export const PROMOTION_OFFER_STATUSES = ['pending', 'accepted', 'rejected', 'expired'] as const;
export type PromotionOfferStatus = (typeof PROMOTION_OFFER_STATUSES)[number];

const promotionOfferSchema = new Schema(
  {
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    failedSellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    promotedSellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    promotedSellerNetPaise: { type: Number, required: true },
    deltaPaise: { type: Number, required: true }, // Inclusive-basis extra cost, never negative.
    withinCap: { type: Boolean, required: true },
    status: {
      type: String,
      enum: PROMOTION_OFFER_STATUSES,
      required: true,
      default: 'pending',
    },
    offeredAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true }, // BR-021/WF-11 — 24 hours.
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

promotionOfferSchema.index({ soId: 1, status: 1 });
promotionOfferSchema.index({ status: 1, expiresAt: 1 });

export type PromotionOfferDocument = InferSchemaType<typeof promotionOfferSchema>;
export const PromotionOffer = model<PromotionOfferDocument>(
  'PromotionOffer',
  promotionOfferSchema,
  'promotion_offer',
);
