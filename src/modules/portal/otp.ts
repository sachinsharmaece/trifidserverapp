import { randomInt } from 'node:crypto';
import { LoginOtpModel, OtpRequestAttemptModel, PartyAccountModel } from '../../models/index.js';
import type { PartyType } from '../../shared/enums.js';
import { HttpError, invalidField } from '../../shared/errors.js';
import { fakePasswordCheck, hashPassword, isPasswordCorrect } from '../auth/password.js';
import { logEvent } from '../fastOrder/eventLog.js';
import { sendOtpSms } from './sms.js';

/**
 * Sign-in by one-time code (reference lib/services/otpAuth.ts).
 *
 * Nobody can use these answers to find out whether a mobile number has a login: "Send code" always says the same
 * thing, and "no login", "wrong code" and "expired" all get the same "Invalid or expired code" (and take the same
 * time). A code lasts 5 minutes, allows 5 wrong tries and works once. "Send code" is limited to 5 presses in 10
 * minutes per mobile number, and a new code needs a minute's wait.
 */
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const REQUEST_RATE_LIMIT = 5;
const REQUEST_RATE_WINDOW_MS = 10 * 60 * 1000;
const GENERIC_REQUEST_MESSAGE = 'If this number is registered, a code has been sent.';
const GENERIC_VERIFY_ERROR = 'Invalid or expired code';

const isValidMobile = (mobile: string) => /^\d{10}$/.test(mobile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejectVerify(code: string): Promise<never> {
  await fakePasswordCheck(code); // the same work as a real check, so the time says nothing
  throw invalidCode();
}
const invalidCode = () =>
  new HttpError(401, 'INVALID_OTP', GENERIC_VERIFY_ERROR, [
    { path: 'otp', message: GENERIC_VERIFY_ERROR },
  ]);

export async function requestOtp(partyType: PartyType, mobile: string) {
  if (!isValidMobile(mobile)) throw invalidField('mobile', 'Enter a valid 10-digit mobile number');
  const recent = await OtpRequestAttemptModel.countDocuments({
    mobile,
    partyType,
    createdAt: { $gte: new Date(Date.now() - REQUEST_RATE_WINDOW_MS) },
  });
  if (recent >= REQUEST_RATE_LIMIT) {
    throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Too many requests. Please try again later.');
  }
  await OtpRequestAttemptModel.create({ mobile, partyType });

  const account = await PartyAccountModel.findOne({ mobile, partyType, active: true });
  if (!account) {
    await sleep(200); // keep the "no login" answer from being quicker than the real one
    return { message: GENERIC_REQUEST_MESSAGE };
  }
  const live = await LoginOtpModel.findOne({
    partyAccountId: account._id,
    consumedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (
    live &&
    (live as unknown as { createdAt: Date }).createdAt.getTime() > Date.now() - RESEND_COOLDOWN_MS
  ) {
    throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Please wait before requesting another code.');
  }
  if (live) await LoginOtpModel.updateOne({ _id: live._id }, { expiresAt: new Date() });

  const code = String(randomInt(100000, 1000000));
  await LoginOtpModel.create({
    partyAccountId: account._id,
    codeHash: await hashPassword(code),
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
  });
  await sendOtpSms(account.mobile, code);
  await logEvent({
    category: 'PORTAL',
    entityType: 'PartyAccount',
    entityId: account._id,
    partyId: account.buyerId ?? account.sellerId ?? null,
    action: 'OTP_REQUESTED',
  });
  return { message: GENERIC_REQUEST_MESSAGE };
}

/** Checks the code. Right: the login (for the caller to start a session). Wrong: 401, the same for every reason. */
export async function verifyOtp(partyType: PartyType, mobile: string, code: string) {
  if (!isValidMobile(mobile)) throw invalidField('mobile', 'Enter a valid 10-digit mobile number');
  const account = await PartyAccountModel.findOne({ mobile, partyType, active: true });
  if (!account) return rejectVerify(code);
  const otp = await LoginOtpModel.findOne({
    partyAccountId: account._id,
    consumedAt: { $exists: false },
  }).sort({ createdAt: -1 });
  if (!otp || otp.expiresAt < new Date() || otp.attemptCount >= otp.maxAttempts) {
    return rejectVerify(code);
  }
  if (!(await isPasswordCorrect(otp.codeHash, code))) {
    const attempts = otp.attemptCount + 1;
    await LoginOtpModel.updateOne({ _id: otp._id }, { $inc: { attemptCount: 1 } });
    if (attempts >= otp.maxAttempts) {
      await logEvent({
        category: 'PORTAL',
        entityType: 'PartyAccount',
        entityId: account._id,
        partyId: account.buyerId ?? account.sellerId ?? null,
        action: 'LOGIN_LOCKED',
      });
    }
    throw invalidCode();
  }
  const now = new Date();
  await LoginOtpModel.updateOne({ _id: otp._id }, { consumedAt: now });
  await PartyAccountModel.updateOne({ _id: account._id }, { lastLoginAt: now });
  await logEvent({
    category: 'PORTAL',
    entityType: 'PartyAccount',
    entityId: account._id,
    partyId: account.buyerId ?? account.sellerId ?? null,
    action: 'LOGIN_SUCCESS',
  });
  return account;
}
