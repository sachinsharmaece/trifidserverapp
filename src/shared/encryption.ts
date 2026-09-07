import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * ARCHITECTURE.md §8 — bank account numbers encrypted at rest, masked in
 * every UI, never in logs. AES-256-GCM: the key comes from
 * BANK_DETAIL_ENCRYPTION_KEY (32 raw bytes, base64), never hardcoded.
 *
 * Output format `iv:authTag:ciphertext`, each base64 — self-contained so a
 * key rotation only needs the key, not a second column.
 */
const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const key = Buffer.from(env.bankDetailEncryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'BANK_DETAIL_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key).',
    );
  }
  return key;
}

export function encryptAccountNumber(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptAccountNumber(encoded: string): string {
  const [ivPart, authTagPart, ciphertextPart] = encoded.split(':');
  if (!ivPart || !authTagPart || !ciphertextPart) {
    throw new Error('Malformed encrypted account number.');
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagPart, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// Masked in every UI (ARCHITECTURE.md §8) — the only form of the account
// number that is ever allowed into a DTO or a log line.
export function maskAccountNumber(plainText: string): string {
  if (plainText.length <= 4) return '*'.repeat(plainText.length);
  return `${'*'.repeat(plainText.length - 4)}${plainText.slice(-4)}`;
}
