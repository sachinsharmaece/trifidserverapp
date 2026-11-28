import { Schema, model, type InferSchemaType } from 'mongoose';
import { PARTY_TYPES } from '../shared/enums.js';

/**
 * One "Send code" press (reference OtpRequestAttempt), counted by the mobile number typed, not by the login: so the
 * limit (5 in 10 minutes) cannot be used to find out whether a number has a login. Deleted after a day.
 */
const otpRequestAttemptSchema = new Schema(
  {
    mobile: { type: String, required: true, maxlength: 20 },
    partyType: { type: String, enum: PARTY_TYPES, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'otp_request_attempts', versionKey: false },
);

otpRequestAttemptSchema.index({ mobile: 1, partyType: 1, createdAt: -1 });
otpRequestAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type OtpRequestAttempt = InferSchemaType<typeof otpRequestAttemptSchema>;
export const OtpRequestAttemptModel = model('OtpRequestAttempt', otpRequestAttemptSchema);
