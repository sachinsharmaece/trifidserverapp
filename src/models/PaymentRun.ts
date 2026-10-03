import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-36 `payment_run`. BR-016/INV-16 — built by one person, released by
 * another; `builtBy` may never equal `releasedBy`, whatever the role
 * (enforced in payment.service.ts via chain.guards.ts
 * `assertBuilderIsNotReleaser`, and again by the route requiring
 * re-authentication on release). BR-020 — runs at 13:00/16:00/19:00, an
 * editable `config` array (TD-009), never hard-coded.
 */
const paymentRunSchema = new Schema(
  {
    scheduledAt: { type: Date, required: true, default: () => new Date() },
    items: [
      {
        kind: { type: String, enum: ['payout', 'refund'], required: true },
        partyId: { type: Schema.Types.ObjectId, required: true },
        partyType: { type: String, enum: ['buyer', 'seller'], required: true },
        amountPaise: { type: Number, required: true },
        refId: { type: Schema.Types.ObjectId, required: true }, // Po (payout) or Refund
      },
    ],
    builtBy: { type: Schema.Types.ObjectId, required: true },
    releasedBy: { type: Schema.Types.ObjectId, default: null },
    releasedAt: { type: Date, default: null },
    utrs: [{ type: String }],
    // `sent_back`: the checker declined to release it. Nothing moved; every item in it is
    // free to go into a new batch (an item counts as "in a batch" only while a run is `built`).
    state: {
      type: String,
      enum: ['built', 'released', 'sent_back'],
      required: true,
      default: 'built',
    },
    sentBackBy: { type: Schema.Types.ObjectId, default: null },
    sentBackAt: { type: Date, default: null },
    sentBackReason: { type: String, default: null },
  },
  { timestamps: true },
);

paymentRunSchema.index({ state: 1, scheduledAt: 1 });

export type PaymentRunDocument = InferSchemaType<typeof paymentRunSchema>;
export const PaymentRun = model<PaymentRunDocument>('PaymentRun', paymentRunSchema, 'payment_run');
