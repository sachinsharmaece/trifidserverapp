import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-24 `pool`. BR-151 — a pool belongs to a condition set on a SKU, not
 * to one seller's listing. `conditionSetKey` is the four-field composite
 * (expiry band · MOQ band · delivery band · provenance) rendered as a
 * single string so it can be a unique index — "fragmentation is the
 * silent failure mode."
 */
export const POOL_STATUSES = ['open', 'reconfirm', 'triggered', 'converted', 'reopened'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

export function buildConditionSetKey(parts: {
  expiryBand: string;
  moqBand: string;
  deliveryBand: string;
  provenance: string;
}): string {
  return `${parts.expiryBand}|${parts.moqBand}|${parts.deliveryBand}|${parts.provenance}`;
}

const poolSchema = new Schema(
  {
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', required: true },
    conditionSetKey: { type: String, required: true },
    expiryBand: { type: String, required: true },
    moqBand: { type: String, required: true },
    deliveryBand: { type: String, required: true },
    provenance: { type: String, required: true },
    moq: { type: Number, required: true, min: 1 }, // BR-150 — the MOQ this pool must reach to trigger.
    status: { type: String, enum: POOL_STATUSES, required: true, default: 'open' },
    // Mirrors `status` — true only while `open`/`reconfirm`. A separate
    // boolean rather than deriving the index from `status` directly
    // because MongoDB partial-index filters support equality, not `$in`;
    // this is set to `false` in the same write that moves status to
    // `triggered`/`converted`/`reopened`.
    isActive: { type: Boolean, required: true, default: true },
    triggeredAt: { type: Date, default: null },
    payDeadline: { type: Date, default: null }, // BR-156 — 16h from trigger.
    reconfirmRequestedAt: { type: Date, default: null }, // BR-154 — the one 75% re-confirmation request.
  },
  { timestamps: true },
);

// Only one *active* (open or reconfirm) pool per SKU + condition set at a
// time — a triggered/converted/reopened pool does not block a fresh one
// from opening on the same key later.
poolSchema.index(
  { skuId: 1, conditionSetKey: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

export type PoolDocument = InferSchemaType<typeof poolSchema>;
export const Pool = model<PoolDocument>('Pool', poolSchema, 'pool');
