import { logger } from '../../shared/logger.js';

/**
 * Sends the sign-in code (reference lib/sms.ts). No SMS provider is connected yet, so the code is written to the
 * server log instead ("[DEV OTP]"), as the reference does when AWS SNS is not set up. Connecting a provider later
 * means changing this file only.
 *
 * Outside production the last code per mobile is also kept in memory (`devOtpOutbox`), so automated tests can
 * sign in. It is never kept in production.
 */
export const devOtpOutbox = new Map<string, string>();

export function sendOtpSms(mobile: string, code: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production') devOtpOutbox.set(mobile, code);
  logger.info({ msg: `[DEV OTP] ${mobile}: ${code} (not sent — no SMS provider is connected)` });
  return Promise.resolve();
}
