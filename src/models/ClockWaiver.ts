import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-46 `clock_waiver`. BR-234 — "the lifeline." The desk may extend a
 * clock with a logged reason and a checker; it operates in bulk — one
 * waiver row covers every PO extended in a single action. This session
 * covers only `Po.dispatchDueDate` (BR-173/BR-174); `BR-195`'s buyer-side
 * collection clock has no field to extend yet.
 */
const clockWaiverSchema = new Schema(
  {
    entityIds: [{ type: Schema.Types.ObjectId, required: true }],
    hoursExtended: { type: Number, required: true },
    reason: { type: String, required: true },
    raisedBy: { type: Schema.Types.ObjectId, required: true },
    approvedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

export type ClockWaiverDocument = InferSchemaType<typeof clockWaiverSchema>;
export const ClockWaiver = model<ClockWaiverDocument>(
  'ClockWaiver',
  clockWaiverSchema,
  'clock_waiver',
);
