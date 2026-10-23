import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  gstinMatchesStateCode,
  isValidAadhaar,
  isValidGstin,
  isValidMobile,
  isValidPan,
  isValidPincode,
  normalizeMobile,
  panFromGstin,
  passesVerhoeff,
} from '../src/shared/validators.js';

// The same file is copied into both front-end repos (see its _comment), so
// all three implementations answer these examples identically.
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/validator-vectors.json', import.meta.url), 'utf8'),
) as {
  mobile: { valid: [string, string][]; invalid: string[] };
  gstin: { valid: string[]; invalid: string[] };
  gstinStateCode: { match: [string, string][]; mismatch: [string, string][] };
  panFromGstin: [string, string][];
  pan: { valid: string[]; invalid: string[] };
  employeePan: { valid: string[]; invalid: string[] };
  aadhaar: { valid: string[]; invalid: string[] };
  pincode: { valid: string[]; invalid: string[] };
};

describe('shared validators (Phase 0)', () => {
  it('normalises and validates mobiles', () => {
    for (const [raw, normalised] of vectors.mobile.valid) {
      expect(normalizeMobile(raw)).toBe(normalised);
      expect(isValidMobile(raw)).toBe(true);
    }
    for (const raw of vectors.mobile.invalid) expect(isValidMobile(raw)).toBe(false);
  });

  it('validates GSTIN shape and checksum', () => {
    for (const gstin of vectors.gstin.valid) expect(isValidGstin(gstin)).toBe(true);
    for (const gstin of vectors.gstin.invalid) expect(isValidGstin(gstin)).toBe(false);
  });

  it('matches the GSTIN state code, skipping 97 Other Territory', () => {
    for (const [gstin, code] of vectors.gstinStateCode.match) {
      expect(gstinMatchesStateCode(gstin, code)).toBe(true);
    }
    for (const [gstin, code] of vectors.gstinStateCode.mismatch) {
      expect(gstinMatchesStateCode(gstin, code)).toBe(false);
    }
  });

  it('takes the PAN from GSTIN characters 3–12', () => {
    for (const [gstin, pan] of vectors.panFromGstin) expect(panFromGstin(gstin)).toBe(pan);
  });

  it('validates PAN, with the person-only rule for employees', () => {
    for (const pan of vectors.pan.valid) expect(isValidPan(pan)).toBe(true);
    for (const pan of vectors.pan.invalid) expect(isValidPan(pan)).toBe(false);
    for (const pan of vectors.employeePan.valid) {
      expect(isValidPan(pan, { personOnly: true })).toBe(true);
    }
    for (const pan of vectors.employeePan.invalid) {
      expect(isValidPan(pan, { personOnly: true })).toBe(false);
    }
  });

  it('validates Aadhaar with the Verhoeff checksum', () => {
    // Wikipedia's worked Verhoeff example: 236 has check digit 3.
    expect(passesVerhoeff('2363')).toBe(true);
    expect(passesVerhoeff('2364')).toBe(false);
    for (const aadhaar of vectors.aadhaar.valid) expect(isValidAadhaar(aadhaar)).toBe(true);
    for (const aadhaar of vectors.aadhaar.invalid) expect(isValidAadhaar(aadhaar)).toBe(false);
  });

  it('validates pincodes', () => {
    for (const pincode of vectors.pincode.valid) expect(isValidPincode(pincode)).toBe(true);
    for (const pincode of vectors.pincode.invalid) expect(isValidPincode(pincode)).toBe(false);
  });
});
