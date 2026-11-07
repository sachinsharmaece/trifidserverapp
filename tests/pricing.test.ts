import { describe, expect, it } from 'vitest';
import {
  computeAbsorptionCapPaise,
  computeBuyerInclusiveRatePaise,
  computeBuyerInclusiveRatePaiseWithRupeeMargin,
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
// one golden block below is the worked example from DECISIONS_ROUND2_CHANGESET.md
// §2, restated on the GST-inclusive basis of DEC-045 and DEC-077 (buyer and
// seller rates both include GST).

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const TRIALS = 200;

describe('pricing.ts — every rate is GST-inclusive (DEC-045, DEC-077)', () => {
  // The regression guard for the two GST bugs: the 13 Sep one (GST added on top of a buyer rate
  // that already contains it) and the 7 Nov one (GST grossed up onto a seller quote that already
  // contains it, so a class-% margin sold a ₹150 quote at ₹185.85 while the ₹ margin sold it at ₹152).
  it('a buyer rate at zero margin is the seller quote — no GST is added', () => {
    const sellerQuotePaise = 371_00;
    expect(computeBuyerInclusiveRatePaise(sellerQuotePaise, 0)).toBe(sellerQuotePaise);
  });

  it('a class % and the same amount in rupees price the buyer identically', () => {
    // ₹150 quote: 5% is ₹7.50.
    expect(computeBuyerInclusiveRatePaise(150_00, 0.05)).toBe(157_50);
    expect(computeBuyerInclusiveRatePaiseWithRupeeMargin(150_00, 7_50)).toBe(157_50);
  });

  it('the buyer and seller lines for the same rate and quantity are the same money', () => {
    const buyer = computeBuyerLineMoney(21, 20, 446_54, 'intra_state');
    const seller = computeSellerLineMoney(21, 20, 446_54, 'intra_state');
    expect(seller).toEqual(buyer);
  });
});

describe('pricing.ts — computeBuyerInclusiveRatePaise', () => {
  it('at zero margin returns the seller quote exactly', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const sellerQuotePaise = randomInt(1, 10_000_00);
      expect(computeBuyerInclusiveRatePaise(sellerQuotePaise, 0)).toBe(sellerQuotePaise);
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

describe('pricing.ts — fractional baseUnitsPerBox (350 ML × 30 = 10.5 L a box)', () => {
  it('prices a fractional box to whole paise, in every direction', () => {
    // 20 boxes × 10.5 L × 25000 paise = 5,250,000 exactly.
    const exact = computeBuyerLineMoney(20, 10.5, 25_000, 'intra_state');
    expect(exact.totalPaise).toBe(5_250_000);
    for (let i = 0; i < TRIALS; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 400) / 2 + 0.5; // x.5 — the worst case for rounding.
      const ratePaise = randomInt(1, 50_000);
      const place = Math.random() < 0.5 ? 'intra_state' : 'inter_state';
      const buyer = computeBuyerLineMoney(boxes, baseUnitsPerBox, ratePaise, place);
      expect(Number.isInteger(buyer.totalPaise)).toBe(true);
      expect(buyer.totalPaise).toBe(Math.round(boxes * baseUnitsPerBox * ratePaise));
      expect(buyer.taxablePaise + buyer.taxPortionPaise).toBe(buyer.totalPaise);
      const { cgstPaise, sgstPaise, igstPaise } = buyer.taxSplit;
      expect(cgstPaise + sgstPaise + igstPaise).toBe(buyer.taxPortionPaise);

      const seller = computeSellerLineMoney(boxes, baseUnitsPerBox, ratePaise, place);
      expect(Number.isInteger(seller.taxablePaise)).toBe(true);
      expect(Number.isInteger(seller.totalPaise)).toBe(true);
      expect(seller.taxablePaise + seller.taxPortionPaise).toBe(seller.totalPaise);
      expect(computeExtendedValuePaise(boxes, baseUnitsPerBox, ratePaise)).toBe(
        Math.round(boxes * baseUnitsPerBox * ratePaise),
      );
    }
  });

  it('still refuses a negative or non-finite quantity per box, and fractional boxes', () => {
    expect(() => computeBuyerLineMoney(1, -1, 100, 'intra_state')).toThrow(TypeError);
    expect(() => computeBuyerLineMoney(1, Number.NaN, 100, 'intra_state')).toThrow(TypeError);
    expect(() => computeBuyerLineMoney(1.5, 10.5, 100, 'intra_state')).toThrow(TypeError);
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

  it('the worked example — Roundup 1 LTR, 20 litres to a box, 21 boxes', () => {
    // Seller quotes ₹371.00/LTR, GST included. Class A / Dealer margin 2%.
    const sellerQuotePaise = 371_00;
    const buyerRate = computeBuyerInclusiveRatePaise(sellerQuotePaise, 0.02);
    expect(buyerRate).toBe(378_42); // ₹378.42/LTR, tax-inclusive

    const line = computeBuyerLineMoney(21, 20, buyerRate, 'intra_state');
    expect(line.totalPaise).toBe(15_893_640); // ₹1,58,936.40 — exact
    expect(line.taxablePaise + line.taxPortionPaise).toBe(line.totalPaise);

    // TriFid pays the seller his quote, GST included, and keeps the 2% on top of it.
    const sellerLine = computeSellerLineMoney(21, 20, sellerQuotePaise, 'intra_state');
    expect(sellerLine.totalPaise).toBe(15_582_000); // 21 × 20 × ₹371.00
    expect((line.totalPaise - sellerLine.totalPaise) / sellerLine.totalPaise).toBeCloseTo(0.02, 4);
  });
});

describe('pricing.ts — computeSellerLineMoney / computeSellerBillTotalFromTaxable', () => {
  it('the line total is the quote times the quantity — what TriFid pays the seller', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const boxes = randomInt(1, 500);
      const baseUnitsPerBox = randomInt(1, 200);
      const ratePaise = randomInt(1, 50_000);
      const line = computeSellerLineMoney(boxes, baseUnitsPerBox, ratePaise, 'intra_state');
      expect(line.totalPaise).toBe(boxes * baseUnitsPerBox * ratePaise);
      expect(line.taxablePaise + line.taxPortionPaise).toBe(line.totalPaise);
    }
  });

  it('GST is split out of the total, not added to it', () => {
    // ₹150 a litre × 100 litres = ₹15,000 payable; taxable ₹12,711.86, GST ₹2,288.14.
    const line = computeSellerLineMoney(10, 10, 150_00, 'intra_state');
    expect(line.totalPaise).toBe(15_000_00);
    expect(line.taxablePaise).toBe(12_711_86);
    expect(line.taxPortionPaise).toBe(2_288_14);
  });

  it('adds GST on top of a taxable figure and rounds once', () => {
    for (let i = 0; i < TRIALS; i += 1) {
      const taxablePaise = randomInt(0, 1_000_000_00);
      const { totalPaise, taxPortionPaise } = computeSellerBillTotalFromTaxable(taxablePaise);
      expect(taxablePaise + taxPortionPaise).toBe(totalPaise);
      expect(totalPaise).toBe(Math.round((taxablePaise * (100 + GST_RATE_PERCENT)) / 100));
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
