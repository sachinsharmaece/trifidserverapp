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

// DEC-054 — when a GSTIN is entered, the holder's PAN is its characters
// 3–12 (1-based), so the form fills PAN from it and locks it.
export function panFromGstin(gstin: string): string {
  return gstin.slice(2, 12);
}

// The first two digits of a GSTIN are the GST state code of the state it
// was issued in. "97 Other Territory" can never match: the GSTIN shape only
// allows a first digit of 0–3 there in practice, so no prefix check applies.
const STATE_CODE_WITHOUT_GSTIN_PREFIX = '97';

export function gstinMatchesStateCode(gstin: string, gstStateCode: string): boolean {
  if (gstStateCode === STATE_CODE_WITHOUT_GSTIN_PREFIX) return true;
  return gstin.slice(0, 2) === gstStateCode;
}

// Mobile: a 10-digit Indian mobile, after stripping what people commonly
// type around it — spaces/hyphens, a `+91` (or bare `91` on a 12-digit
// number) country code, or a leading trunk `0`.
const MOBILE_SHAPE = /^[6-9]\d{9}$/;

export function normalizeMobile(raw: string): string {
  let digits = raw.replace(/[\s-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export function isValidMobile(raw: string): boolean {
  return MOBILE_SHAPE.test(normalizeMobile(raw));
}

// PAN: 5 letters, 4 digits, 1 letter. The 4th character is the holder type
// (P person, F firm, C company, H HUF, ...) — an employee's PAN must be a
// person's; a buyer's or seller's may be any holder type.
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function isValidPan(pan: string, options: { personOnly?: boolean } = {}): boolean {
  if (!PAN_SHAPE.test(pan)) return false;
  return !options.personOnly || pan[3] === 'P';
}

// Aadhaar: 12 digits, never starting 0 or 1, last digit a Verhoeff check
// digit over the first eleven (UIDAI's published scheme).
const AADHAAR_SHAPE = /^[2-9]\d{11}$/;
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when `digits` (check digit last) passes the Verhoeff check. */
export function passesVerhoeff(digits: string): boolean {
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(reversed[i])]!]!;
  }
  return c === 0;
}

export function isValidAadhaar(aadhaar: string): boolean {
  return AADHAAR_SHAPE.test(aadhaar) && passesVerhoeff(aadhaar);
}

// Pincode: six digits, never starting with 0.
const PINCODE_SHAPE = /^[1-9]\d{5}$/;

export function isValidPincode(pincode: string): boolean {
  return PINCODE_SHAPE.test(pincode);
}

// IFSC: 4 alphabetic bank code, literal '0', 6 alphanumeric branch code.
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(ifsc: string): boolean {
  return IFSC_SHAPE.test(ifsc);
}

// The catalogue now carries seeds and fertilizers as well as pesticides, so an
// HSN is no longer pinned to chapter 3808 — and is independent of the product
// category. Shape only: 6 or 8 digits. The HSN master holds the tax rate.
const HSN_SHAPE = /^(\d{6}|\d{8})$/;

export function isValidHsn(hsn: string): boolean {
  return HSN_SHAPE.test(hsn);
}

// No single national format exists for state-issued insecticide dealer
// licence numbers (Insecticides Act, 1968 / Insecticides Rules, 1971) — this
// is a length/charset guard, not a shape+checksum validator like GSTIN/IFSC.
// Minimum length of 4 rejects the reported bare "LIC" (3 characters) while
// staying compatible with the shortest real fixture/licence formats — a real
// licence (e.g. "MP/IND/INS/2016/0771") runs far longer than this floor.
const LICENCE_SHAPE = /^[A-Za-z0-9/-]{4,}$/;

export function isValidLicenceNo(licenceNo: string): boolean {
  return LICENCE_SHAPE.test(licenceNo.trim());
}

// B-21 follow-up (found by the existing test suite, not the ticket): a
// plain `\b` boundary never fires between a digit and a letter, so "1L" or
// "2L" — as common as "500 GM" — never matched at all once this same
// function got wired into more call sites. The boundary before the token
// is now "start of string, whitespace, or a digit"; after, "end of string
// or a non-letter", so it still won't match a unit letter buried in an
// unrelated word (e.g. "Gold").
const PACK_UNIT_TOKEN = /(?<=^|[\s\d])(ML|LTRS?|L|GMS?|G|KGS?)(?=$|[^a-zA-Z])/i;

/** PC packs are described too many ways ("10x10 strip", box counts, ...) to require an explicit unit token. */
export function packLabelMatchesBaseUnit(
  packLabel: string,
  baseUnit: 'LTR' | 'KG' | 'PC',
): boolean {
  if (baseUnit === 'PC') return true;
  const match = PACK_UNIT_TOKEN.exec(packLabel);
  if (!match) return false;
  const token = match[1]!.toUpperCase();
  const impliedUnit = token.startsWith('L') || token.startsWith('M') ? 'LTR' : 'KG';
  return impliedUnit === baseUnit;
}

function normalizeForSimilarity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Loose token-overlap check — a soft signal, not a rejection (bank account names legitimately differ from trade names). */
export function namesAreSimilar(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (na.length < 2 || nb.length < 2) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  for (const w of wordsA) {
    if (wordsB.has(w)) return true;
  }
  return false;
}
