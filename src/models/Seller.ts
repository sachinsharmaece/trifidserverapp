import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-05 `seller`. One per counterparty whose `kind` is `seller` or `both`.
 * BR-246 — four tiers, lifetime cumulative, **monotonic**: enforced in the
 * service layer (a tier assignment never moves the value backward), not
 * here — a schema enum has no notion of ordering to enforce.
 *
 * **A seller has no rate tier** — TriFid never quotes him a price (`BR-251`).
 */
const sellerSchema = new Schema(
  {
    counterpartyId: {
      type: Schema.Types.ObjectId,
      ref: 'Counterparty',
      required: true,
      unique: true,
    },
    trustTier: {
      type: String,
      enum: ['New', 'Verified', 'Trusted', 'Committed'],
      required: true,
      default: 'New',
    },
    tierSeededBy: { type: Schema.Types.ObjectId, default: null },
    tierSeededReason: { type: String, default: null },
    dispatchCutoffTime: { type: String, required: true, default: '16:00' },
    suppliesCompleted: { type: Number, required: true, default: 0 },
    openingBalancePaise: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export type SellerDocument = InferSchemaType<typeof sellerSchema>;
export const Seller = model<SellerDocument>('Seller', sellerSchema, 'seller');
