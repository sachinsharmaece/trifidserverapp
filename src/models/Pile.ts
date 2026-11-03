import { Schema, model, type InferSchemaType } from 'mongoose';
import { proxyLogField } from '../shared/proxyLog.js';

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
    // 2 Nov — a line takes one group at a time, not one for life: BR-136 accepts sequential piles
    // (a split fill on a slower clock), so a new group opens once the last was confirmed and its
    // orders made. The one-open-group rule is the partial unique index below.
    listingLineId: { type: Schema.Types.ObjectId, ref: 'ListingLine', required: true },
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
    // 2 Nov — BR-134: a short pile (`shortfall`) waits for the desk to say who gets the boxes.
    // Set once, when Sales has divided the boxes the seller can send; until then the line is shut.
    shortfallResolvedAt: { type: Date, default: null },
    shortfallResolvedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    sellerLockedUntil: { type: Date, default: null }, // BR-032 — 24h from the seller's confirm.
    // Staff-assisted enquiries — present only when Purchase decided this
    // pile (confirm/requote/decline) on a phone call.
    proxyLog: proxyLogField,
  },
  { timestamps: true },
);

// At most one OPEN group (no decision yet) per line: two requests racing to open one both find
// none, and the loser of this index reads the winner's. Keyed differently from the old unique
// `listingLineId_1` index on purpose, so the two never clash while that one is still there.
pileSchema.index(
  { listingLineId: 1, decision: 1 },
  {
    unique: true,
    partialFilterExpression: { decision: { $type: 'null' } },
    name: 'one_open_pile_per_line',
  },
);
// Looking a line's groups up, newest first.
pileSchema.index({ listingLineId: 1, openedAt: -1 }, { name: 'piles_by_line' });

export type PileDocument = InferSchemaType<typeof pileSchema>;
export const Pile = model<PileDocument>('Pile', pileSchema, 'pile');
