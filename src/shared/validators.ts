/** Small, dependency-free checks shared by models (and later by Zod request schemas). */

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The 15th character of a GSTIN is a checksum over the first 14 (mod-36 Luhn variant). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14.charAt(i));
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36);
}

/** Valid format AND checksum, e.g. 23ABCDE1234F1Z5. Expects upper case (models upper-case before validating). */
export function isValidGstin(gstin: string): boolean {
  return GSTIN_FORMAT.test(gstin) && gstin.charAt(14) === gstinCheckChar(gstin.slice(0, 14));
}

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PINCODE_PATTERN = /^[1-9]\d{5}$/;
/** HSN codes are 4, 6 or 8 digits (SRS-MST-03). */
export const HSN_PATTERN = /^(\d{4}|\d{6}|\d{8})$/;

/** Lower-cased, trimmed, inner spaces collapsed: the key used for case-insensitive uniqueness. */
export function normaliseKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
