import { Schema, model, type InferSchemaType } from 'mongoose';
import { intField, refField } from './_fields.js';

/**
 * A one-time sign-in code for a portal login (reference LoginOtp). Only a hash of the code is kept, like a password.
 * It lasts 5 minutes, allows 5 wrong tries, and can be used once. MongoDB deletes it a day after it expires.
 */
const loginOtpSchema = new Schema(
  {
    partyAccountId: { ...refField('PartyAccount'), required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attemptCount: { ...intField(0, 100), required: true, default: 0 },
    maxAttempts: { ...intField(1, 100), required: true, default: 5 },
    consumedAt: Date,
  },
  { collection: 'login_otps', timestamps: true, versionKey: false },
);

loginOtpSchema.index({ partyAccountId: 1, createdAt: -1 });
loginOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type LoginOtp = InferSchemaType<typeof loginOtpSchema>;
export const LoginOtpModel = model('LoginOtp', loginOtpSchema);
