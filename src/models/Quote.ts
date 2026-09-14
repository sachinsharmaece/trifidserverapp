import { Schema, model, type InferSchemaType } from 'mongoose';
import { DELIVERY_BANDS, EXPIRY_BANDS, PROVENANCE_VALUES } from './ListingLine.js';

/**
 * ENT-20 `quote`. BR-124 — net rate FOR Indore, no inbound freight field.
 * BR-063 — `rank`/`ofCount` are computed; the winning rate is never stored
 * on a losing quote and never returned to a seller in any field.
 */
export const QUOTE_STATUSES = ['live', 'won', 'lost', 'expired', 'promoted', 'withdrawn'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

// BR-273 — fixed gap codes only, never free text.
export const QUOTE_GAP_CODES = [
  'short_on_quantity',
  'expiry_below_requirement',
  'delivery_too_slow',
  'moq_above_ask',
] as const;
export type QuoteGapCode = (typeof QUOTE_GAP_CODES)[number];

const quoteSchema = new Schema(
  {
    askId: { type: Schema.Types.ObjectId, ref: 'Ask', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    ratePaiseForIndore: { type: Number, required: true },
    qtyAvailable: { type: Number, required: true, min: 1 },
    conditionSet: {
      expiryBand: { type: String, enum: EXPIRY_BANDS, required: true },
      expiryExact: { type: String, required: true }, // Fixed at quote time (BR-102's exception for the seller's own screen).
      deliveryBand: { type: String, enum: DELIVERY_BANDS, required: true },
      provenance: { type: String, enum: PROVENANCE_VALUES, required: true },
      batch: { type: String, default: null }, // Mandatory only when provenance is `auth` (BR-105).
    },
    daysToIndore: { type: Number, required: true, min: 0 },
    bindingUntil: { type: Date, required: true }, // now + 24h (API-045) — starts the buyer's hold, never restarts it.
    status: { type: String, enum: QUOTE_STATUSES, required: true, default: 'live' },
    rank: { type: Number, default: null },
    ofCount: { type: Number, default: null },
    gapCodes: [{ type: String, enum: QUOTE_GAP_CODES }],
  },
  { timestamps: true },
);

quoteSchema.index({ askId: 1, ratePaiseForIndore: 1 }); // Cheapest-first allocation.
quoteSchema.index({ sellerId: 1, status: 1 });

export type QuoteDocument = InferSchemaType<typeof quoteSchema>;
export const Quote = model<QuoteDocument>('Quote', quoteSchema, 'quote');
