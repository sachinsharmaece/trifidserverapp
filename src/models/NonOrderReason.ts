import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-47 `non_order_reason`. BR-269 — every non-order carries a coded
 * reason, split two ways. Purchase is accountable for `supply_gap` only;
 * `buyer_choice` belongs to Sales (`BR-269`'s own text) and is out of this
 * milestone's Purchase-desk scope, so its codes are defined here for the
 * data model's completeness but M6 only ever writes `supply_gap` rows.
 */
export const NON_ORDER_BUCKETS = ['supply_gap', 'buyer_choice'] as const;
export type NonOrderBucket = (typeof NON_ORDER_BUCKETS)[number];

export const SUPPLY_GAP_CODES = [
  'rate_above_market',
  'expiry_too_short',
  'delivery_too_slow',
  'moq_too_big',
  'quantity_short',
  'no_seller_in_scope',
] as const;
export type SupplyGapCode = (typeof SUPPLY_GAP_CODES)[number];

export const BUYER_CHOICE_CODES = [
  'already_holds_stock',
  'buys_direct_from_company',
  'doesnt_trust_us_yet',
  'price_checking',
  'wrong_product',
  'no_longer_needed',
] as const;
export type BuyerChoiceCode = (typeof BUYER_CHOICE_CODES)[number];

const nonOrderReasonSchema = new Schema(
  {
    askId: { type: Schema.Types.ObjectId, ref: 'Ask', default: null },
    pileId: { type: Schema.Types.ObjectId, ref: 'Pile', default: null },
    bucket: { type: String, enum: NON_ORDER_BUCKETS, required: true },
    code: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

nonOrderReasonSchema.index({ askId: 1 });
nonOrderReasonSchema.index({ bucket: 1, code: 1 });

export type NonOrderReasonDocument = InferSchemaType<typeof nonOrderReasonSchema>;
export const NonOrderReason = model<NonOrderReasonDocument>(
  'NonOrderReason',
  nonOrderReasonSchema,
  'non_order_reason',
);
