import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-57 `auth_session`. TD-006 — a rotating refresh token, hashed at rest,
 * revocable. `tokenFamily` groups every rotation of the same login together
 * so reuse of an already-rotated token can revoke the whole family
 * (ARCHITECTURE.md §5.3).
 *
 * One-session-per-GSTIN semantics are pending QR-031; the interim behaviour
 * (revoke prior sessions for the counterparty on a fresh OTP verify) is
 * implemented in modules/identity/auth.service.ts and called out there.
 */
const authSessionSchema = new Schema(
  {
    actorType: { type: String, enum: ['counterparty', 'staff'], required: true },
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', default: null },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    refreshTokenHash: { type: String, required: true },
    tokenFamily: { type: String, required: true },
    deviceFingerprint: { type: String },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: false },
);

authSessionSchema.index({ counterpartyId: 1, revokedAt: 1 });
authSessionSchema.index({ employeeId: 1, revokedAt: 1 });
authSessionSchema.index({ tokenFamily: 1 });
// DATA_MODEL.md §2.5 — sessions retained 90 days after expiry.
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export type AuthSessionDocument = InferSchemaType<typeof authSessionSchema>;
export const AuthSession = model<AuthSessionDocument>(
  'AuthSession',
  authSessionSchema,
  'auth_session',
);
