import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-37 `refund`. BR-019 — a refund is a payable with a different reason
 * code, not a different screen, queue or approval path; it shares the
 * `payment_run` head with a payout. BR-018 — releases only to the account
 * the money came from; a mismatch holds and flags
 * (`held_mismatch`, chain.guards.ts `assertRefundDestinationMatchesSource`).
 */
export const REFUND_REASON_CODES = [
  'supply_failure_full',
  'part_rejection_quantity_reduction',
  'payment_window_expired',
  'buyer_silence_on_ghosting',
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

const refundSchema = new Schema(
  {
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    amountPaise: { type: Number, required: true },
    reasonCode: { type: String, enum: REFUND_REASON_CODES, required: true },
    state: {
      type: String,
      enum: ['not_payable', 'payable', 'in_batch', 'released', 'held_mismatch'],
      required: true,
      default: 'payable',
    },
    runId: { type: Schema.Types.ObjectId, ref: 'PaymentRun', default: null },
    targetAccountMasked: { type: String, required: true },
  },
  { timestamps: true },
);

refundSchema.index({ chainId: 1 });
refundSchema.index({ state: 1 });

export type RefundDocument = InferSchemaType<typeof refundSchema>;
export const Refund = model<RefundDocument>('Refund', refundSchema, 'refund');
