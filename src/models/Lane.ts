import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-15 `lane`. BR-261 — a lane is a funnel joint or a leak: one
 * assignable object, exactly one owner, no unassigned state. `CH §18.2`
 * names the fixed board — the Purchase desk's Funnel B joints and leaks
 * (B1–B8). Seeded once at startup, same pattern as `db/seedRoles.ts`.
 */
const laneSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    funnel: { type: String, required: true },
    label: { type: String, required: true },
  },
  { timestamps: true },
);

export type LaneDocument = InferSchemaType<typeof laneSchema>;
export const Lane = model<LaneDocument>('Lane', laneSchema, 'lane');
