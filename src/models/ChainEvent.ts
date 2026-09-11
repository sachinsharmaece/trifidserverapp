import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * BR-037 — every document opens in full, with a complete event log: who,
 * what, when, why, old value → new value. `audit_log` (ENT-53) already
 * records generic field-level diffs across every collection; `chain_event`
 * is the chain-specific narrative timeline BR-031's chain strip and BR-037's
 * document view render — "SO raised", "PO released", "leg 1 dispatched",
 * "inspection signed", "Marg matched", and so on, one row per stage-moving
 * or money-moving act on this chain. Referenced in DATA_MODEL.md §2.2's
 * never-mutated-in-place list; not given its own `ENT-##` there — this
 * session's DATA_MODEL.md update fixes that gap.
 */
const chainEventSchema = new Schema(
  {
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    type: { type: String, required: true },
    refCollection: { type: String, required: true },
    refId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    actorType: { type: String, enum: ['counterparty', 'staff', 'system'], required: true },
    reason: { type: String, default: null },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    summary: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

chainEventSchema.index({ chainId: 1, at: 1 });

export type ChainEventDocument = InferSchemaType<typeof chainEventSchema>;
export const ChainEvent = model<ChainEventDocument>('ChainEvent', chainEventSchema, 'chain_event');
