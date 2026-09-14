import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-23 `claim`. BR-139/BR-140 — the claim board. Behind
 * `config.claim_board`, which **ships off** and does not go to production
 * without a written Competition Act §3(3) opinion. First-come-wins needs a
 * database-level guard, not an application check — the unique index below
 * on `{pileId}` (a pile may only ever be claimed once) is that guard.
 */
const claimSchema = new Schema(
  {
    pileId: { type: Schema.Types.ObjectId, ref: 'Pile', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    claimedAt: { type: Date, required: true, default: () => new Date() },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// First-come-wins, enforced at the database level: at most one *active*
// (not undone) claim per pile — BR-137's five-second undo frees the pile
// for someone else to claim, so the uniqueness only applies while
// `undoneAt` is still null.
claimSchema.index({ pileId: 1 }, { unique: true, partialFilterExpression: { undoneAt: null } });

export type ClaimDocument = InferSchemaType<typeof claimSchema>;
export const Claim = model<ClaimDocument>('Claim', claimSchema, 'claim');
