import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-21 `pile`. BR-133 — demand accumulates on a listing line into a pile;
 * one decision covers every request on it. BR-135 — the accumulation
 * window is a desk chase, not an expiry: there is deliberately no
 * `expired` state and no code path that lapses a pile on its own.
 */
export const PILE_DECISIONS = ['confirmed', 'requoted', 'declined'] as const;
export type PileDecision = (typeof PILE_DECISIONS)[number];

const pileSchema = new Schema(
  {
    listingLineId: {
      type: Schema.Types.ObjectId,
      ref: 'ListingLine',
      required: true,
      unique: true,
    },
    openedAt: { type: Date, required: true, default: () => new Date() },
    confirmWindowEndsAt: { type: Date, required: true }, // BR-135 — default 12h, a chase not an expiry.
    decidedAt: { type: Date, default: null },
    decision: { type: String, enum: PILE_DECISIONS, default: null },
    confirmedQty: { type: Number, default: null }, // BR-134 — may be less than asked (short pile).
    expiryExact: { type: String, default: null }, // Fixed on confirm (BR-102).
    batch: { type: String, default: null }, // Mandatory only when the line's provenance is `auth` (BR-105).
    shortfall: { type: Boolean, required: true, default: false }, // BR-134 — desk adjudication, no automatic rule.
    // BR-137 — the deferred-commit window. `executedAt` is set only once the
    // scheduled fan-out job has actually run; null between confirm and then
    // means "still cancellable" (worker/agendaProducer.ts).
    executedAt: { type: Date, default: null },
    sellerLockedUntil: { type: Date, default: null }, // BR-032 — 24h from the seller's confirm.
  },
  { timestamps: true },
);

export type PileDocument = InferSchemaType<typeof pileSchema>;
export const Pile = model<PileDocument>('Pile', pileSchema, 'pile');
