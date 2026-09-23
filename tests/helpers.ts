import type { Express } from 'express';
import request from 'supertest';
import { generate, generateSecret } from 'otplib';
import { MFA_REQUIRED_ROLE_KEYS } from '../src/config/permissions.js';

export function randomMobile(): string {
  const rest = Math.floor(100000000 + Math.random() * 899999999)
    .toString()
    .padStart(9, '0');
  return `9${rest}`;
}

export function randomEmail(): string {
  return `test-${Date.now()}-${Math.floor(Math.random() * 100000)}@trifid.example`;
}

const GSTIN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomLetters(length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += GSTIN_ALPHABET[Math.floor(Math.random() * GSTIN_ALPHABET.length)];
  }
  return result;
}

function randomDigits(length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += Math.floor(Math.random() * 10).toString();
  }
  return result;
}

// A checksum-valid, format-valid GSTIN with random (fictional) parts —
// enough to exercise real validation logic in a test without needing a
// real firm's real GSTIN.
export async function randomGstin(): Promise<string> {
  const { computeGstinChecksum } = await import('../src/shared/validators.js');
  const first14 = `${randomDigits(2)}${randomLetters(5)}${randomDigits(4)}${randomLetters(1)}1Z`;
  return `${first14}${computeGstinChecksum(first14)}`;
}

// ---------------------------------------------------------------------------
// M10 — staff sign-in. Controller, Admin and Founder must use an authenticator
// (CH §24.3), enforced by role, so a test that signs one in has to enrol a real
// secret and answer the challenge with a real TOTP code.
// ---------------------------------------------------------------------------
export function needsMfa(roleKeys: string[]): boolean {
  return roleKeys.some((key) => MFA_REQUIRED_ROLE_KEYS.has(key));
}

/** A secret to create an MFA-role employee with; `undefined` for every other role. */
export function mfaSecretFor(roleKeys: string[]): string | undefined {
  return needsMfa(roleKeys) ? generateSecret() : undefined;
}

/** Signs a staff member in end to end, answering the MFA challenge when there is one. */
export async function loginStaff(
  app: Express,
  email: string,
  password: string,
  mfaSecret?: string,
): Promise<string> {
  const login = await request(app).post('/api/v1/auth/staff/login').send({ email, password });
  if (login.body.data?.mfaRequired) {
    if (!mfaSecret) throw new Error('This account needs a TOTP secret to sign in.');
    const verify = await request(app)
      .post('/api/v1/auth/staff/mfa/verify')
      .send({ mfaToken: login.body.data.mfaToken, code: await generate({ secret: mfaSecret }) });
    return verify.body.data.accessToken as string;
  }
  return login.body.data.accessToken as string;
}
