import { describe, expect, it } from 'vitest';
import {
  computeAbsorptionCapPaise,
  computeBuyerInclusiveRatePaise,
  computeBuyerLineMoney,
  computeExtendedValuePaise,
  computeSellerBillTotalFromTaxable,
  computeSellerLineMoney,
  isMargValueMatched,
  isPaymentSatisfied,
  splitTax,
  GST_RATE_PERCENT,
  MARG_TOLERANCE_PAISE,
} from '../src/shared/pricing.js';

// Mostly property tests rather than golden numbers, per the M4 brief. The
// one golden block below is the client's own worked example from
// DECISIONS_ROUND2_CHANGESET.md §2, now that DEC-045 has settled the
// direction (buyer rates are TAX-INCLUSIVE) and the formula is no longer an
// inference.

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const TRIALS = 200;

describe('pricing.ts — the buyer/seller basis asymmetry (DEC-045)', () => {
  // This is the regression guard for the 18% direction bug found on
  // 13 Sep 2026: the module had been computing the buyer's total by adding
  // GST on top of a rate the client says already contains it.
  it('a buyer rate is grossed up by GST; a seller rate is not', () => {
    const sellerNetPaise = 371_00;
    const buyerRate = computeBuyerInclusiveRatePaise(sellerNetPaise, 0);
    expect(buyerRate).toBeGreaterThan(sellerNetPaise);
    expect(buyerRate).toBe(Math.round((sellerNetPaise * (100 + GST_RATE_PERCENT)) / 100));
  });

  it('the buyer total is NOT the seller total for the same rate and quantity', () => {
    const boxes = 21;
    const baseUnitsPerBox = 20;
    const ratePaise = 446_54;
    const buyer = computeBuyerLineMoney(boxes, baseUnitsPerBox, ratePaise, 'intra_state');
    const seller = computeSellerLineMoney(boxes, baseUnitsPerBox, ratePaise, 'intra_state');
    expect(buyer.totalPaise).toBeLessThan(seller.totalPaise);
    // The buyer's rate already contains the tax; the seller's does not.
    expect(buyer.taxablePaise).toBeLessThan(seller.taxablePaise);
  });
});

describe('pricing.ts — computeBuyerInclusiveRatePaise', () => {
  it('at zero margin returns the seller net grossed up by GST, never the bare net', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerNetPaise = randomInt(1, 10_000_00);
      const rate = computeBuyerInclusiveRatePaise(sellerNetPaise, 0);
      expect(rate).toBe(Math.round((sellerNetPaise * (100 + GST_RATE_PERCENT)) / 100));
    }
  });

  it('is monotonic in margin', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerNetPaise = randomInt(1, 10_000_00);
      const lowerMargin = Math.random() * 0.1;
      const higherMargin = lowerMargin + Math.random() * 0.1;
      expect(computeBuyerInclusiveRatePaise(sellerNetPaise, higherMargin)).toBeGreaterThanOrEqual(
        computeBuyerInclusiveRatePaise(sellerNetPaise, lowerMargin),
      );
    }
  });

  it('refuses a negative margin — BR-021, a negative line is an alarm, not a state', () => {
    expect(() => computeBuyerInclusiveRatePaise(10000, -0.01)).toThrow();
  });

  it('always returns an integer number of paise — QR-035, two decimal places', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const rate = computeBuyerInclusiveRatePaise(randomInt(1, 10_000_00), Math.random() * 0.5);
      expect(Number.isInteger(rate)).toBe(true);
    }
  });
});

describe('pricing.ts — computeBuyerLineMoney (CH §22.2)', () => {
  it('the total is EXACT — a dealer multiplying the on-screen rate lands on the invoice figure', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const line = computeBuyerLineMoney(boxes, baseUnitsPerBox, ratePaise, 'intra_state');
      expect(line.totalPaise).toBe(boxes * baseUnitsPerBox * ratePaise);
    }
  });

  it('taxable + tax always re-sums to the total exactly, both places of supply', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const place = Math.random() < 0.5 ? 'intra_state' : 'inter_state';
      const line = computeBuyerLineMoney(
        randomInt(1, 500),
        randomInt(1, 200),
        randomInt(1, 50_000),
        place,
      );
      expect(line.taxablePaise + line.taxPortionPaise).toBe(line.totalPaise);
      const { cgstPaise, sgstPaise, igstPaise } = line.taxSplit;
      expect(cgstPaise + sgstPaise + igstPaise).toBe(line.taxPortionPaise);
    }
  });

  it('the reverse-computed taxable value grosses back up to the total within one paisa', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const line = computeBuyerLineMoney(
        randomInt(1, 500),
        randomInt(1, 200),
        randomInt(1, 50_000),
        'intra_state',
      );
      const grossedBack = (line.taxablePaise * (100 + GST_RATE_PERCENT)) / 100;
      expect(Math.abs(grossedBack - line.totalPaise)).toBeLessThanOrEqual(1);
    }
  });

  it('the client worked example — DECISIONS_ROUND2_CHANGESET.md §2', () => {
    // Roundup 1 LTR, 20 litres to a box, 21 boxes.
    // Seller quotes ₹371.00/LTR taxable. Class A / Dealer margin 2%.
    const sellerNetPaise = 371_00;
    const buyerRate = computeBuyerInclusiveRatePaise(sellerNetPaise, 0.02);
    expect(buyerRate).toBe(446_54); // ₹446.54/LTR, tax-inclusive

    const line = computeBuyerLineMoney(21, 20, buyerRate, 'intra_state');
    expect(line.totalPaise).toBe(18_754_680); // ₹1,87,546.80 — exact
    expect(line.taxablePaise + line.taxPortionPaise).toBe(line.totalPaise);

    // Margin survives the gross-up: TriFid's taxable margin is still 2%.
    const sellerLine = computeSellerLineMoney(21, 20, sellerNetPaise, 'intra_state');
    const marginPaise = line.taxablePaise - sellerLine.taxablePaise;
    expect(marginPaise / sellerLine.taxablePaise).toBeCloseTo(0.02, 4);
  });
});

describe('pricing.ts — computeSellerLineMoney / computeSellerBillTotalFromTaxable', () => {
  it('adds GST on top of the taxable value and rounds once', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxablePaise = randomInt(0, 1_000_000_00);
      const { totalPaise, taxPortionPaise } = computeSellerBillTotalFromTaxable(taxablePaise);
      expect(taxablePaise + taxPortionPaise).toBe(totalPaise);
      expect(totalPaise).toBe(Math.round((taxablePaise * (100 + GST_RATE_PERCENT)) / 100));
    }
  });

  it('the line taxable value is exact — no rounding at the extension step', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const line = computeSellerLineMoney(boxes, baseUnitsPerBox, ratePaise, 'intra_state');
      expect(line.taxablePaise).toBe(boxes * baseUnitsPerBox * ratePaise);
    }
  });

  it('is monotonic in the taxable value', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const lower = randomInt(0, 500_000_00);
      const higher = lower + randomInt(1, 500_000_00);
      expect(computeSellerBillTotalFromTaxable(higher).totalPaise).toBeGreaterThan(
        computeSellerBillTotalFromTaxable(lower).totalPaise,
      );
    }
  });

  it('computing twice gives the same answer (pure, deterministic)', () => {
    expect(computeSellerBillTotalFromTaxable(66750_00)).toEqual(
      computeSellerBillTotalFromTaxable(66750_00),
    );
  });
});

describe('pricing.ts — computeExtendedValuePaise', () => {
  it('is exact and monotonic in quantity', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const fewerBoxes = randomInt(1, 250);
      const moreBoxes = fewerBoxes + randomInt(1, 250);
      expect(computeExtendedValuePaise(fewerBoxes, baseUnitsPerBox, ratePaise)).toBe(
        fewerBoxes * baseUnitsPerBox * ratePaise,
      );
      expect(computeExtendedValuePaise(moreBoxes, baseUnitsPerBox, ratePaise)).toBeGreaterThan(
        computeExtendedValuePaise(fewerBoxes, baseUnitsPerBox, ratePaise),
      );
    }
  });
});

describe('pricing.ts — splitTax', () => {
  it('intra-state CGST + SGST always re-sums exactly; IGST is zero', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxPortionPaise = randomInt(0, 1_000_000_00);
      const split = splitTax(taxPortionPaise, 'intra_state');
      expect(split.cgstPaise + split.sgstPaise).toBe(taxPortionPaise);
      expect(split.igstPaise).toBe(0);
    }
  });

  it('inter-state IGST is the whole tax portion; CGST/SGST are zero', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxPortionPaise = randomInt(0, 1_000_000_00);
      const split = splitTax(taxPortionPaise, 'inter_state');
      expect(split.igstPaise).toBe(taxPortionPaise);
      expect(split.cgstPaise).toBe(0);
      expect(split.sgstPaise).toBe(0);
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
  it('never exceeds 1% of order value, nor the margin on the line', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const soTotalPaise = randomInt(1000, 100_000_00);
      const marginOnLinePaise = randomInt(0, 100_000_00);
      const cap = computeAbsorptionCapPaise(soTotalPaise, marginOnLinePaise);
      expect(cap).toBeLessThanOrEqual(Math.round(soTotalPaise * 0.01));
      expect(cap).toBeLessThanOrEqual(marginOnLinePaise);
    }
  });

  it('zero margin is the hard maximum — no escalation path past it', () => {
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
      expect(isPaymentSatisfied(randomInt(0, soTotalPaise - 1), soTotalPaise)).toBe(false);
    }
  });
});
