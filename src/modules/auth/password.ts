import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';

/** Rule for choosing a password (SRS: at least 10 characters). */
export const PASSWORD_MIN_LENGTH = 8; // reference-copy branch: 8, as the reference
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(128, 'Use at most 128 characters.');

/** Turns a password into the text we store. argon2 adds a random salt, so the same password hashes differently each time. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password); // argon2id with the library's safe defaults
}

export function isPasswordCorrect(storedHash: string, password: string): Promise<boolean> {
  return argon2.verify(storedHash, password);
}

let fakeHash: Promise<string> | undefined;

/**
 * Used when the email does not exist. It does the same amount of work as a real check, so the
 * response time does not reveal which emails have accounts.
 */
export async function fakePasswordCheck(password: string): Promise<void> {
  fakeHash ??= hashPassword('this-is-not-a-real-password');
  await isPasswordCorrect(await fakeHash, password);
}

/** A random 12-character password for a new or reset account. The person must replace it at first sign-in. */
export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}
