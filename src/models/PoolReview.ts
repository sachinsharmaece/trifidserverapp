import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * LOCK-34 `pool_review`. The Team Leader's "Leave" on the 3-day list: this
 * party was looked at for this stay in the Pool, so it drops off his list
 * until it next re-enters the Pool (a new `poolEnteredAt`).
 */
const poolReviewSchema = new Schema(
  {
    partyId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    poolEnteredAt: { type: Date, required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    reviewedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

poolReviewSchema.index({ partyId: 1, poolEnteredAt: 1 });

export type PoolReviewDocument = InferSchemaType<typeof poolReviewSchema>;
export const PoolReview = model<PoolReviewDocument>('PoolReview', poolReviewSchema, 'pool_review');
