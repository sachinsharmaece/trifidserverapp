import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-48 `pulse_event`. BR-278 — unit is area × product; an event is an ask
 * or an order. BR-279 — the echo rule: an order arising from TriFid's own
 * push (a desk call, a broadcast) is excluded from the event count via
 * `fromOurPush`, or "the system hallucinates a window out of its own
 * noise." Written at the moment an ask is raised or an SO is created;
 * `fromOurPush` defaults false (organic) and is set true only by a caller
 * that knows it originated from a desk action, not a buyer's own initiative.
 */
export const PULSE_EVENT_KINDS = ['ask', 'order'] as const;
export type PulseEventKind = (typeof PULSE_EVENT_KINDS)[number];

const pulseEventSchema = new Schema(
  {
    areaTehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    kind: { type: String, enum: PULSE_EVENT_KINDS, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    fromOurPush: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

pulseEventSchema.index({ areaTehsilId: 1, productId: 1, at: -1 });

export type PulseEventDocument = InferSchemaType<typeof pulseEventSchema>;
export const PulseEvent = model<PulseEventDocument>('PulseEvent', pulseEventSchema, 'pulse_event');
