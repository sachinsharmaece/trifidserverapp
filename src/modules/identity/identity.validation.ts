import { z } from 'zod';

// BR — the login identifier for a counterparty is a 10-digit Indian mobile
// number, no country code, no leading zero (CH §2.1.4).
const mobileSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');

export const otpRequestSchema = z
  .object({
    mobile: mobileSchema,
  })
  .strict();

export const otpVerifySchema = z
  .object({
    requestId: z.string().min(1),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
    deviceFingerprint: z.string().min(1),
  })
  .strict();

export const staffLoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const staffMfaVerifySchema = z
  .object({
    mfaToken: z.string().min(1),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
  })
  .strict();

export const logoutSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .strict();

export const reauthSchema = z
  .object({
    password: z.string().min(1),
    mfaCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
