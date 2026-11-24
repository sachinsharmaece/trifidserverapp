import { Schema, model } from 'mongoose';
import { IDEMPOTENCY_STATUSES } from '../shared/enums.js';
import { intField, refField } from './_fields.js';
/**
 * Remembers each write request's `Idempotency-Key` so a retried or double-clicked request returns the first
 * answer instead of running twice. Rows expire after 72 hours.
 */
const idempotencyKeySchema = new Schema({
    key: { type: String, required: true, maxlength: 100 },
    userId: { ...refField('User'), required: true },
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 500 },
    /** sha256 of the canonical request body: the same key with a different body is refused. */
    requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    status: { type: String, enum: IDEMPOTENCY_STATUSES, required: true, default: 'IN_FLIGHT' },
    responseStatus: intField(100, 599),
    /** Stored response (kept small: ≤ 64 KB by the middleware). */
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, required: true, default: () => new Date() },
}, { collection: 'idempotency_keys', versionKey: false });
idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 72 * 60 * 60 });
export const IdempotencyKeyModel = model('IdempotencyKey', idempotencyKeySchema);
//# sourceMappingURL=idempotencyKey.model.js.map