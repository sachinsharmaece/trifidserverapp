import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Not an ENT — this is a technical support collection, not a business record.
 *
 * A generic counter used for OTP request rate limiting (per mobile, per IP,
 * globally) and for the OTP/staff-login lockout windows. One document per
 * `key`, expiring automatically at `expiresAt` via a TTL index — this is the
 * whole mechanism, not a queue or a cache layer.
 */
const rateLimitSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
});

rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimitDocument = InferSchemaType<typeof rateLimitSchema>;
export const RateLimit = model<RateLimitDocument>('RateLimit', rateLimitSchema, 'rate_limit');
