import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-44 `rate_override`. BR-048 — staff may override the matrix's pre-filled
 * rate with a reason from a fixed dropdown, editable in the master. This row
 * is the audit trail for that override and is what `so_line.staffPriceId`
 * points to when an override happened (null when the pre-fill was accepted
 * with one tap — see models/So.ts).
 */
export const RATE_OVERRIDE_REASON_CODES = [
  'undercutting_local_trader',
  'near_expiry',
  'first_order_with_buyer',
  'freight_unusual',
  'matching_competitor_quote',
  'clearing_slow_stock',
] as const;
export type RateOverrideReasonCode = (typeof RATE_OVERRIDE_REASON_CODES)[number];

const rateOverrideSchema = new Schema(
  {
    soLineId: { type: Schema.Types.ObjectId, ref: 'SoLine', required: true },
    fromPaise: { type: Number, required: true },
    toPaise: { type: Number, required: true },
    reasonCode: { type: String, enum: RATE_OVERRIDE_REASON_CODES, required: true },
    by: { type: Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    // BR-047 — a quoted rate is held 24h for the same buyer asking for the
    // same thing; withinBand records whether this override still respected
    // that hold when it was made.
    withinBand: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

rateOverrideSchema.index({ soLineId: 1 });

export type RateOverrideDocument = InferSchemaType<typeof rateOverrideSchema>;
export const RateOverride = model<RateOverrideDocument>(
  'RateOverride',
  rateOverrideSchema,
  'rate_override',
);
