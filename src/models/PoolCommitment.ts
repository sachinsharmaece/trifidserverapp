import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-25 `pool_commitment`. BR-154 — three commitment states in practice:
 * before 75% soft (isBinding false, withdrawable free); at 75% one
 * re-confirmation request; after 75% binding on entry. BR-155 — one
 * re-confirmation per buyer per pool cycle, tracked by `reconfirmedAt`
 * being set at most once between pool cycles (a fresh pool document after
 * a reopen starts every buyer's cycle over).
 */
const poolCommitmentSchema = new Schema(
  {
    poolId: { type: Schema.Types.ObjectId, ref: 'Pool', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    qty: { type: Number, required: true, min: 1 },
    deliveryLocationId: { type: Schema.Types.ObjectId, ref: 'BuyerLocation', required: true },
    isBinding: { type: Boolean, required: true, default: false },
    reconfirmedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    soId: { type: Schema.Types.ObjectId, ref: 'So', default: null }, // Set once this buyer's own SO exists (BR-133/BR-157).
  },
  { timestamps: true },
);

poolCommitmentSchema.index({ poolId: 1, buyerId: 1 }, { unique: true });

export type PoolCommitmentDocument = InferSchemaType<typeof poolCommitmentSchema>;
export const PoolCommitment = model<PoolCommitmentDocument>(
  'PoolCommitment',
  poolCommitmentSchema,
  'pool_commitment',
);
