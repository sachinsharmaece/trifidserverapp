import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New — M6, `PRD INV-22`/`IC-07`. A buyer asks Sales for a rate the board
 * does not currently show him. `IC-07`'s correction: the response is a
 * fixed refusal code, never free text, and never states a floor, a limit or
 * a margin — the desk sees only whether it can meet the ask, not why not in
 * commercial terms. No named refusal-code list exists in `BUSINESS_RULES.md`
 * for this — this session's own coded set, flagged in the session report.
 */
export const MSP_REFUSAL_CODES = [
  'rate_not_available_right_now',
  'quantity_too_small_to_action',
  'no_seller_in_your_area',
  'already_at_the_best_available_rate',
] as const;
export type MspRefusalCode = (typeof MSP_REFUSAL_CODES)[number];

export const MSP_STATUSES = ['pending', 'granted', 'refused'] as const;
export type MspStatus = (typeof MSP_STATUSES)[number];

const mspRequestSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', required: true },
    qty: { type: Number, required: true, min: 1 },
    note: { type: String, default: null }, // Buyer's own free text — read, never parsed for a decision.
    status: { type: String, enum: MSP_STATUSES, required: true, default: 'pending' },
    refusalCode: { type: String, enum: MSP_REFUSAL_CODES, default: null },
    respondedBy: { type: Schema.Types.ObjectId, default: null },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

mspRequestSchema.index({ status: 1 });
mspRequestSchema.index({ buyerId: 1 });

export type MspRequestDocument = InferSchemaType<typeof mspRequestSchema>;
export const MspRequest = model<MspRequestDocument>('MspRequest', mspRequestSchema, 'msp_request');
