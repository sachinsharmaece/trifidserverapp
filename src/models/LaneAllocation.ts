import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-15 `lane_allocation`. BR-262 — exactly one holder per lane, set in
 * the employee master and then fixed; the desk head does not reassign at
 * will. Unique on `laneKey` (not `{laneKey, employeeId}`) because "exactly
 * one holder" means at most one *row* per lane, not one row per pair.
 */
const laneAllocationSchema = new Schema(
  {
    laneKey: { type: String, required: true, unique: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  },
  { timestamps: true },
);

export type LaneAllocationDocument = InferSchemaType<typeof laneAllocationSchema>;
export const LaneAllocation = model<LaneAllocationDocument>(
  'LaneAllocation',
  laneAllocationSchema,
  'lane_allocation',
);
