import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-56 `auth_otp`. API-001/API-002 — hashed OTP, 5-minute TTL, single use.
 * The document's own `_id` is returned to the client as `requestId` so verify
 * never needs the mobile number resent (API_CONTRACT.md API-002).
 *
 * Rate limiting and the 30-minute lockout are tracked separately in
 * `RateLimit` (models/RateLimit.ts), keyed by mobile/IP — not on this
 * document — so a lockout survives across several OTP requests.
 */
const authOtpSchema = new Schema(
  {
    mobile: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    // Developer addition, not in DATA_MODEL.md ENT-56 — set when this code was
    // reissued as a new-device step-up challenge (API-002 NEW_DEVICE), so the
    // matching verify call can tell "already device-checked" from "first try".
    deviceFingerprint: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

authOtpSchema.index({ mobile: 1, createdAt: -1 });
// DATA_MODEL.md §2.5 — OTP records retained 30 days, then purged.
authOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export type AuthOtpDocument = InferSchemaType<typeof authOtpSchema>;
export const AuthOtp = model<AuthOtpDocument>('AuthOtp', authOtpSchema, 'auth_otp');
