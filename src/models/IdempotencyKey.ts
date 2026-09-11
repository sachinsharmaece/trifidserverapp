import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Technical support collection, not an `ENT` (same category as `rate_limit`
 * and `worker_heartbeat`, DATA_MODEL.md §6). MASTER_PLAN.md §M4 item 10 and
 * API_CONTRACT.md §1 — `Idempotency-Key` is required on every POST that
 * creates money or moves a chain stage; a replay with the same key and the
 * same request body returns the original response for 24 hours instead of
 * repeating the side effect. See middleware/idempotency.ts.
 */
const idempotencyKeySchema = new Schema({
  key: { type: String, required: true },
  route: { type: String, required: true },
  requestHash: { type: String, required: true },
  responseStatus: { type: Number, required: true },
  responseBody: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, required: true, default: () => new Date(), expires: 60 * 60 * 24 },
});

idempotencyKeySchema.index({ key: 1, route: 1 }, { unique: true });

export type IdempotencyKeyDocument = InferSchemaType<typeof idempotencyKeySchema>;
export const IdempotencyKey = model<IdempotencyKeyDocument>(
  'IdempotencyKey',
  idempotencyKeySchema,
  'idempotency_key',
);
