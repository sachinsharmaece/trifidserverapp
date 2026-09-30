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

// This desk trades agrochemicals only (sellers hold an insecticide licence,
// products carry a "technical" active ingredient) — every HSN on file is
// chapter 3808, so the prefix is enforced unconditionally rather than
// gated on a product field that has no chemistry meaning (see `class` on
// the Product model, which is a margin/pricing tier, BR-040).
const HSN_SHAPE = /^3808\d{2,4}$/; // 3808 + 2/4/6 digits = 6 or 8 digits total.

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
