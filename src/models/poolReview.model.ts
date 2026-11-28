import { Schema, model, type InferSchemaType } from 'mongoose';
import { refField } from './_fields.js';

/**
 * The Sales Team Leader pressed "Leave" on a Pool buyer (reference LOCK-34 PoolReview): it drops off his
 * "Waiting 3+ days" list until it next comes into the Pool.
 */
const poolReviewSchema = new Schema(
  {
    partyId: { ...refField('Buyer'), required: true },
    poolEnteredAt: { type: Date, required: true },
    reviewedBy: { ...refField('User'), required: true },
    reviewedAt: { type: Date, required: true },
  },
  { collection: 'pool_reviews', versionKey: false },
);

poolReviewSchema.index({ partyId: 1, poolEnteredAt: 1 });

export type PoolReview = InferSchemaType<typeof poolReviewSchema>;
export const PoolReviewModel = model('PoolReview', poolReviewSchema);
