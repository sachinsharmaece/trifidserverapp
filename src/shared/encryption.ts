import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from './errors.js';

/**
 * Locks a piece of text (a bank account number) so the database holds only unreadable text.
 * Method: AES-256-GCM with the secret key from DATA_ENCRYPTION_KEY. GCM also detects tampering: if the stored
 * text is changed, or the key is wrong, `decryptText` throws instead of returning something wrong.
 *
 * The saved text looks like `v1:<iv>:<tag>:<locked text>` (all base64). `v1` says which key/method was used,
 * so a new key can be introduced later without breaking old values.
 */
const VERSION = 'v1';

function secretKey(): Buffer {
  if (!env.dataEncryptionKey) {
    throw new HttpError(
      500,
      'ENCRYPTION_KEY_MISSING',
      'DATA_ENCRYPTION_KEY is not set on the server, so bank details cannot be saved yet. Add it to the server .env file (see .env.example).',
    );
  }
  return Buffer.from(env.dataEncryptionKey, 'hex');
}

export function encryptText(plain: string): string {
  const iv = randomBytes(12); // a new random iv every time, so the same number never looks the same twice
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const locked = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), locked].map((bytes) => bytes.toString('base64'));
  return [VERSION, ...parts].join(':');
}

export function decryptText(saved: string): string {
  const [version, iv, tag, locked] = saved.split(':');
  if (version !== VERSION || !iv || !tag || !locked) throw new Error('Unknown encrypted format.');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(locked, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * A fingerprint of a text (a bank account number): the same number always gives the same fingerprint, and the number
 * cannot be worked out from it. It lets us spot "this account is already used by another seller" without
 * decrypting anything. (HMAC-SHA256 with a key made from the secret key, so it is not the encryption key itself.)
 */
export function hashText(plain: string): string {
  const hashKey = createHmac('sha256', secretKey()).update('trifid:account-hash').digest();
  return createHmac('sha256', hashKey).update(plain).digest('hex');
}
