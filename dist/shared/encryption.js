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
function keyFrom(base64, name) {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) {
        throw new Error(`${name} must decode to exactly 32 bytes (base64-encoded AES-256 key).`);
    }
    return key;
}
function getKey() {
    return keyFrom(env.bankDetailEncryptionKey, 'BANK_DETAIL_ENCRYPTION_KEY');
}
function encryptWith(key, plainText) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}
function decryptWith(key, encoded, what) {
    const [ivPart, authTagPart, ciphertextPart] = encoded.split(':');
    if (!ivPart || !authTagPart || !ciphertextPart) {
        throw new Error(`Malformed encrypted ${what}.`);
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagPart, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64')),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
}
export function encryptAccountNumber(plainText) {
    return encryptWith(getKey(), plainText);
}
export function decryptAccountNumber(encoded) {
    return decryptWith(getKey(), encoded, 'account number');
}
// Masked in every UI (ARCHITECTURE.md §8) — the only form of the account
// number that is ever allowed into a DTO or a log line.
export function maskAccountNumber(plainText) {
    if (plainText.length <= 4)
        return '*'.repeat(plainText.length);
    return `${'*'.repeat(plainText.length - 4)}${plainText.slice(-4)}`;
}
/**
 * Phase 2 (DEC-061) — an employee's PAN and Aadhaar, under their own key
 * (PII_ENCRYPTION_KEY). Same format as the bank-detail ciphertext. Decrypted
 * only on an Admin's explicit, audited reveal; every other path shows the
 * masked form, built from the last four characters kept beside it.
 */
function getPiiKey() {
    return keyFrom(env.piiEncryptionKey, 'PII_ENCRYPTION_KEY');
}
export function encryptPii(plainText) {
    return encryptWith(getPiiKey(), plainText);
}
export function decryptPii(encoded) {
    return decryptWith(getPiiKey(), encoded, 'PII value');
}
/** `XXXXXX234F` — PAN with only its last four characters showing. */
export function maskPan(last4) {
    return `XXXXXX${last4}`;
}
/** `XXXX XXXX 1234` — Aadhaar with only its last four digits showing. */
export function maskAadhaar(last4) {
    return `XXXX XXXX ${last4}`;
}
