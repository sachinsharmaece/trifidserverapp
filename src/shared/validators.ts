/**
 * GSTIN and IFSC are government-published formats with a public checksum
 * algorithm — implementing them is not a business-rule invention, it is
 * the "format and checksum validation" the M3 session brief asks for.
 */

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTIN_CODE_POINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Shared by isValidGstin and computeGstinChecksum (the latter is exported
// for tests — building a fixture GSTIN by hand and hoping it passes the
// checksum is exactly how a previous version of this file's test fixtures
// went wrong).
function checksumCharFor(first14: string): string {
  let factor = 2;
  let sum = 0;
  const mod = 36;
  for (let i = first14.length - 1; i >= 0; i -= 1) {
    const codePoint = GSTIN_CODE_POINTS.indexOf(first14[i]!);
    let digit = factor * codePoint;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }
  return GSTIN_CODE_POINTS[(mod - (sum % mod)) % mod]!;
}

export function isValidGstin(gstin: string): boolean {
  if (!GSTIN_SHAPE.test(gstin)) return false;
  return checksumCharFor(gstin.slice(0, 14)) === gstin[14];
}

// Test/fixture helper — computes the correct 15th character for a
// checksum-valid GSTIN given its first 14 characters.
export function computeGstinChecksum(first14: string): string {
  return checksumCharFor(first14);
}

// IFSC: 4 alphabetic bank code, literal '0', 6 alphanumeric branch code.
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(ifsc: string): boolean {
  return IFSC_SHAPE.test(ifsc);
}
