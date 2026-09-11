import { describe, expect, it } from 'vitest';
import {
  computeAbsorptionCapPaise,
  computeBuyerRatePaise,
  computeLineMoney,
  computeTaxablePaise,
  computeTotalWithGst,
  isMargValueMatched,
  isPaymentSatisfied,
  splitTax,
  MARG_TOLERANCE_PAISE,
} from '../src/shared/pricing.js';

// Property tests, not golden numbers (BUSINESS_RULES.md §4 / M4 session
// brief) — the exact formula rests on an unconfirmed inference and is
// expected to be replaced by golden fixtures once the client confirms it in
// one line. These check invariants that must hold whatever the confirmed
// formula turns out to be shaped like within this reading.

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const TRIALS = 200;

describe('pricing.ts — computeBuyerRatePaise', () => {
  it('never produces a rate below the seller net at zero margin', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerNetPaise = randomInt(1, 10_000_00);
      expect(computeBuyerRatePaise(sellerNetPaise, 0)).toBe(sellerNetPaise);
    }
  });

  it('is monotonic in margin — a bigger margin never produces a smaller rate', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerNetPaise = randomInt(1, 10_000_00);
      const lowerMargin = Math.random() * 0.1;
      const higherMargin = lowerMargin + Math.random() * 0.1;
      const lowerRate = computeBuyerRatePaise(sellerNetPaise, lowerMargin);
      const higherRate = computeBuyerRatePaise(sellerNetPaise, higherMargin);
      expect(higherRate).toBeGreaterThanOrEqual(lowerRate);
    }
  });

  it('refuses a negative margin — BR-021, a negative line is an alarm, not a state', () => {
    expect(() => computeBuyerRatePaise(10000, -0.01)).toThrow();
  });

  it('always returns an integer number of paise', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerNetPaise = randomInt(1, 10_000_00);
      const marginPct = Math.random() * 0.5;
      expect(Number.isInteger(computeBuyerRatePaise(sellerNetPaise, marginPct))).toBe(true);
    }
  });
});

describe('pricing.ts — computeTaxablePaise', () => {
  it('is exact — no rounding at the taxable-value step', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      expect(computeTaxablePaise(boxes, baseUnitsPerBox, ratePaise)).toBe(
        boxes * baseUnitsPerBox * ratePaise,
      );
    }
  });

  it('is monotonic in quantity', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const fewerBoxes = randomInt(1, 250);
      const moreBoxes = fewerBoxes + randomInt(1, 250);
      const fewer = computeTaxablePaise(fewerBoxes, baseUnitsPerBox, ratePaise);
      const more = computeTaxablePaise(moreBoxes, baseUnitsPerBox, ratePaise);
      expect(more).toBeGreaterThan(fewer);
    }
  });
});

describe('pricing.ts — computeTotalWithGst / splitTax (Q3a)', () => {
  it('the tax portion always re-sums to the rounded total exactly', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxablePaise = randomInt(0, 1_000_000_00);
      const { totalPaise, taxPortionPaise } = computeTotalWithGst(taxablePaise);
      expect(taxablePaise + taxPortionPaise).toBe(totalPaise);
    }
  });

  it('intra-state CGST + SGST always re-sums to the tax portion exactly', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxablePaise = randomInt(0, 1_000_000_00);
      const { taxPortionPaise } = computeTotalWithGst(taxablePaise);
      const split = splitTax(taxPortionPaise, 'intra_state');
      expect(split.cgstPaise + split.sgstPaise).toBe(taxPortionPaise);
      expect(split.igstPaise).toBe(0);
    }
  });

  it('inter-state IGST equals the whole tax portion, CGST/SGST are zero', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxablePaise = randomInt(0, 1_000_000_00);
      const { taxPortionPaise } = computeTotalWithGst(taxablePaise);
      const split = splitTax(taxPortionPaise, 'inter_state');
      expect(split.igstPaise).toBe(taxPortionPaise);
      expect(split.cgstPaise).toBe(0);
      expect(split.sgstPaise).toBe(0);
    }
  });

  it('computing twice gives the same answer (pure, deterministic)', () => {
    const taxablePaise = 66750_00;
    const first = computeTotalWithGst(taxablePaise);
    const second = computeTotalWithGst(taxablePaise);
    expect(first).toEqual(second);
  });

  it('the total is monotonic in the taxable value', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const lower = randomInt(0, 500_000_00);
      const higher = lower + randomInt(1, 500_000_00);
      expect(computeTotalWithGst(higher).totalPaise).toBeGreaterThan(
        computeTotalWithGst(lower).totalPaise,
      );
    }
  });
});

describe('pricing.ts — computeLineMoney (end to end, no drift)', () => {
  it('re-sums exactly across a hundred generated order lines', () => {
    for (let i = 0; i < 100; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const placeOfSupply = Math.random() < 0.5 ? 'intra_state' : 'inter_state';
      const line = computeLineMoney(boxes, baseUnitsPerBox, ratePaise, placeOfSupply);
      expect(line.taxablePaise + line.taxPortionPaise).toBe(line.totalPaise);
      const { cgstPaise, sgstPaise, igstPaise } = line.taxSplit;
      expect(cgstPaise + sgstPaise + igstPaise).toBe(line.taxPortionPaise);
    }
  });
});

describe('pricing.ts — isMargValueMatched (BR-033/Q3b, ₹5 tolerance)', () => {
  it('matches at exactly the ₹5 boundary', () => {
    expect(isMargValueMatched(100000 + MARG_TOLERANCE_PAISE, 100000)).toBe(true);
    expect(isMargValueMatched(100000 - MARG_TOLERANCE_PAISE, 100000)).toBe(true);
  });

  it('queries one paisa beyond the boundary', () => {
    expect(isMargValueMatched(100000 + MARG_TOLERANCE_PAISE + 1, 100000)).toBe(false);
    expect(isMargValueMatched(100000 - MARG_TOLERANCE_PAISE - 1, 100000)).toBe(false);
  });

  it('a ₹90 mismatch (the canonical example, CH §20.5) queries', () => {
    expect(isMargValueMatched(100000 + 9000, 100000)).toBe(false);
  });
});

describe('pricing.ts — computeAbsorptionCapPaise (BR-021/WF-11)', () => {
  it('never exceeds 1% of order value', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const soTotalPaise = randomInt(1000, 100_000_00);
      const marginOnLinePaise = randomInt(0, 100_000_00);
      const cap = computeAbsorptionCapPaise(soTotalPaise, marginOnLinePaise);
      expect(cap).toBeLessThanOrEqual(Math.round(soTotalPaise * 0.01));
    }
  });

  it('never exceeds the margin on the line — zero margin is the hard maximum', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const soTotalPaise = randomInt(1000, 100_000_00);
      const marginOnLinePaise = randomInt(0, 100_000_00);
      const cap = computeAbsorptionCapPaise(soTotalPaise, marginOnLinePaise);
      expect(cap).toBeLessThanOrEqual(marginOnLinePaise);
    }
    expect(computeAbsorptionCapPaise(100_000_00, 0)).toBe(0);
  });
});

describe('pricing.ts — isPaymentSatisfied (BR-010/DEC-023)', () => {
  it('is false until posted receipts reach the SO total', () => {
    expect(isPaymentSatisfied(99999, 100000)).toBe(false);
    expect(isPaymentSatisfied(100000, 100000)).toBe(true);
    expect(isPaymentSatisfied(100001, 100000)).toBe(true);
  });

  it('a partial payment never satisfies the gate', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const soTotalPaise = randomInt(1, 10_000_00);
      const partial = randomInt(0, soTotalPaise - 1);
      expect(isPaymentSatisfied(partial, soTotalPaise)).toBe(false);
    }
  });
});
