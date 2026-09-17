import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-45 `failure_event`. BR-210–BR-220, ST-11 — the conduct ladder.
 * `stage` mirrors ST-11 exactly: a failure inside the grace allowance is
 * `logged` and nothing else happens (BR-212); beyond it, staff walk the
 * ladder by hand — `warning` → `cure_period` → `strike` → `appeal` →
 * `revision` — there is no clock-table entry for cure-period duration, so
 * progression is a staff action (`advanceConductStage`), never automatic.
 * Fraud (BR-217) skips straight to `strike` with `viaFraud: true` and no
 * decay. `decaysAt` is set only once a stage reaches `strike` (BR-213 — a
 * strike decays after six clean months); it is read-time compared against
 * `now`, the same pattern already used for `acquiredBy`'s 45-day decay —
 * no scheduled job walks this collection.
 */
export const FAILURE_STAGES = [
  'logged',
  'warning',
  'cure_period',
  'strike',
  'appeal',
  'revision',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

const failureEventSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    counterpartyKind: { type: String, enum: ['buyer', 'seller'], required: true },
    type: { type: String, required: true }, // BR-215's fixed failure types — coded, never free text.
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', default: null },
    at: { type: Date, required: true, default: () => new Date() },
    withinGrace: { type: Boolean, required: true },
    stage: { type: String, enum: FAILURE_STAGES, required: true },
    viaFraud: { type: Boolean, required: true, default: false }, // BR-217 — outside the ladder entirely.
    decaysAt: { type: Date, default: null },
    disputed: { type: Boolean, required: true, default: false }, // BR-218's disagree button.
    reason: { type: String, default: null }, // Set when staff waive or advance with a logged reason.
    advancedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

failureEventSchema.index({ counterpartyId: 1, at: -1 });
failureEventSchema.index({ counterpartyId: 1, stage: 1, decaysAt: 1 });
failureEventSchema.index({ disputed: 1 });

export type FailureEventDocument = InferSchemaType<typeof failureEventSchema>;
export const FailureEvent = model<FailureEventDocument>(
  'FailureEvent',
  failureEventSchema,
  'failure_event',
);
