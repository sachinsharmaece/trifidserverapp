import { Schema, model, type InferSchemaType } from 'mongoose';
import { SESSION_STATES } from '../shared/enums.js';
import { refField } from './_fields.js';

/**
 * Server-side sessions (ARCH §B3.1). `_id` is a hash of the random token in the cookie, so a leaked
 * database does not hand out live sessions. MongoDB deletes a row automatically once `expiresAt` passes.
 */
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { ...refField('User'), required: true },
    state: { type: String, enum: SESSION_STATES, required: true, default: 'MFA_PENDING' },
    createdAt: { type: Date, required: true, default: () => new Date() },
    /** Idle timeout (12 h) is checked against this on every request. */
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    /** Absolute expiry: 7 days, or 5 minutes while MFA is pending. TTL index below. */
    expiresAt: { type: Date, required: true },
    mfaAt: Date,
    /** Re-authentication for sensitive actions is valid for 5 minutes after this. */
    stepUpAt: Date,
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 300 },
  },
  { collection: 'sessions', versionKey: false },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
