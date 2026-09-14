/**
 * The pricing engine. BUSINESS_RULES.md §4, §17.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ASYMMETRY. Read this before changing anything in here.
 *
 * The two sides of a trade quote in different bases, and this is correct,
 * not a defect:
 *
 *   SELLER → TriFid    TAXABLE.   He raises a GST tax invoice showing
 *                                 taxable value, GST and total. The rate he
 *                                 quotes is the taxable figure.
 *
 *   TriFid → BUYER     INCLUSIVE. Confirmed by the client 13 Sep 2026
 *                                 (DEC-045, QR-002 corrected): "the rate
 *                                 shown is already the final tax-inclusive
 *                                 amount; nothing is added at checkout."
 *
 * Because of that, there is no shared "rate" function in this module. A
 * seller-side call and a buyer-side call are separately named so a
 * misuse is a compile error rather than an 18% money bug.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HISTORY — why the names changed.
 *
 * Until 13 Sep 2026 this module implemented the opposite reading of Q2
 * (taxable rate, GST added on top of the buyer's number too). The client
 * ruled Option A: the buyer's displayed number IS what he pays. The fix is
 * not "stop multiplying by 1.18" — the buyer rate must be grossed UP by
 * 1.18 at the point margin is applied and the total must then stop being
 * multiplied, or GST eats the whole margin and a 2% Class A line goes
 * negative. Every old function name in this module was deliberately retired
 * so the compiler finds every caller.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ORDER OF OPERATIONS (CH §8.2 — margin applies to landed cost; CH §10.21 —
 * GST is a pass-through recovered through input credit, so margin is never
 * calculated on a tax we are about to hand to the government):
 *
 *   sellerRateTaxable      per base unit, FOR Indore        ← what he quotes
 *   buyerRateTaxable     = sellerRateTaxable × (1 + margin)
 *   buyerRateInclusive   = buyerRateTaxable × 1.18          ← what he SEES
 *
 * ROUNDING (Q3a — "GST is never rounded; only the final amount is"):
 *   · A rate is itself a monetary value (DATA_MODEL.md §2.3) and is
 *     quantized to integer paise when frozen onto a line. Integer paise IS
 *     two decimal places of a rupee — QR-035's answer, 13 Sep 2026.
 *   · GST is never computed as an independent rounded figure anywhere. It
 *     is always recovered by SUBTRACTION, so the components always re-sum
 *     to the total exactly.
 *   · The CGST/SGST split divides an already-settled tax portion; it never
 *     rounds each half independently.
 *
 * Every function here is pure and works in integer paise.
 */

import type { Paise } from './money.js';

export const GST_RATE_PERCENT = 18;

/** 100 + GST_RATE_PERCENT, as an integer, so gross-up/gross-down stay exact. */
const GROSS_NUMERATOR = 100 + GST_RATE_PERCENT;

// BR-033/Q3b — a Marg bill within ₹5 of the SO total auto-matches. Beyond
// that: query, and there is no override for any role, including Controller.
export const MARG_TOLERANCE_PAISE: Paise = 500;

export type PlaceOfSupply = 'intra_state' | 'inter_state';

export interface TaxSplit {
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

export interface LineMoney {
  /** The statutory taxable value. Shown on the Marg proforma, never to a buyer. */
  taxablePaise: Paise;
  /** The document total. On the buyer side this is exactly what he transfers. */
  totalPaise: Paise;
  /** Always totalPaise − taxablePaise. Exact, non-negative, never rounded on its own. */
  taxPortionPaise: Paise;
  taxSplit: TaxSplit;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BUYER SIDE — rates are TAX-INCLUSIVE (DEC-045)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * BR-040/BR-045 — the buyer's rate, ready to display and to freeze onto a
 * sales-order line. Margin is applied to the seller's taxable landed cost,
 * and the result is grossed up by GST once, here, so that every downstream
 * calculation can treat the rate as final.
 *
 * `marginPct` is a decimal fraction (0.02 for 2%), never negative —
 * BR-021/CH §10.19.4: a negative-margin line is impossible by construction,
 * so this throws rather than producing one.
 *
 * Replaces the pre-13-Sep `computeBuyerRatePaise`, which returned a taxable
 * figure. Note that at zero margin the result is NO LONGER equal to the
 * seller net — it is the seller net plus GST, which is the point.
 */
export function computeBuyerInclusiveRatePaise(
  sellerNetTaxablePaise: Paise,
  marginPct: number,
): Paise {
  assertNonNegativeInteger(sellerNetTaxablePaise, 'sellerNetTaxablePaise');
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new TypeError(
      `marginPct must be >= 0, got ${marginPct}. A negative margin is an alarm, not a value (BR-021).`,
    );
  }
  const taxable = sellerNetTaxablePaise * (1 + marginPct);
  return Math.round((taxable * GROSS_NUMERATOR) / 100);
}

/**
 * The buyer's line. The rate is already inclusive, so the total is an exact
 * product of integers and needs no rounding at all — which is the cleanest
 * possible reading of Q3a. The taxable value is then reverse-computed for
 * the Marg proforma (CH §22.3 — Marg needs a statutory split to key in, even
 * though the buyer only ever saw one number).
 *
 * Because the total is exact, a dealer multiplying the rate on his screen by
 * his box count lands on the invoice figure precisely — CH §22.2.
 */
export function computeBuyerLineMoney(
  boxes: number,
  baseUnitsPerBox: number,
  inclusiveRatePaise: Paise,
  placeOfSupply: PlaceOfSupply,
): LineMoney {
  assertNonNegativeInteger(boxes, 'boxes');
  assertNonNegativeInteger(baseUnitsPerBox, 'baseUnitsPerBox');
  assertNonNegativeInteger(inclusiveRatePaise, 'inclusiveRatePaise');

  const totalPaise = boxes * baseUnitsPerBox * inclusiveRatePaise;
  const taxablePaise = Math.round((totalPaise * 100) / GROSS_NUMERATOR);
  const taxPortionPaise = totalPaise - taxablePaise;

  return {
    taxablePaise,
    totalPaise,
    taxPortionPaise,
    taxSplit: splitTax(taxPortionPaise, placeOfSupply),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   SELLER SIDE — rates are TAXABLE, GST is added on top
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The seller's line, as it appears on the bill he raises to TriFid: taxable
 * value first, GST added on top, total rounded once (Q3a). This is the path
 * the PO and the seller payout use, and it is unchanged in behaviour from
 * the pre-13-Sep `computeLineMoney` — only its name and its scope are now
 * explicit.
 */
export function computeSellerLineMoney(
  boxes: number,
  baseUnitsPerBox: number,
  taxableRatePaise: Paise,
  placeOfSupply: PlaceOfSupply,
): LineMoney {
  assertNonNegativeInteger(boxes, 'boxes');
  assertNonNegativeInteger(baseUnitsPerBox, 'baseUnitsPerBox');
  assertNonNegativeInteger(taxableRatePaise, 'taxableRatePaise');

  const taxablePaise = boxes * baseUnitsPerBox * taxableRatePaise;
  const totalPaise = Math.round((taxablePaise * GROSS_NUMERATOR) / 100);
  const taxPortionPaise = totalPaise - taxablePaise;

  return {
    taxablePaise,
    totalPaise,
    taxPortionPaise,
    taxSplit: splitTax(taxPortionPaise, placeOfSupply),
  };
}

/**
 * Gross a taxable figure up by GST. Seller side only — a seller's bill
 * total, a debit note against him, a freight recovery. Never call this with
 * a buyer-facing number: a buyer's rate already includes GST (DEC-045).
 */
export function computeSellerBillTotalFromTaxable(taxablePaise: Paise): {
  totalPaise: Paise;
  taxPortionPaise: Paise;
} {
  assertNonNegativeInteger(taxablePaise, 'taxablePaise');
  const totalPaise = Math.round((taxablePaise * GROSS_NUMERATOR) / 100);
  return { totalPaise, taxPortionPaise: totalPaise - taxablePaise };
}

/* ══════════════════════════════════════════════════════════════════════════
   SHARED — direction-neutral
   ══════════════════════════════════════════════════════════════════════════ */

/** BR-055 — quantity is transacted in boxes. Exact, never rounded. Direction-neutral. */
export function computeExtendedValuePaise(
  boxes: number,
  baseUnitsPerBox: number,
  ratePaise: Paise,
): Paise {
  assertNonNegativeInteger(boxes, 'boxes');
  assertNonNegativeInteger(baseUnitsPerBox, 'baseUnitsPerBox');
  assertNonNegativeInteger(ratePaise, 'ratePaise');
  return boxes * baseUnitsPerBox * ratePaise;
}

/**
 * BR-300 — place of supply decides the split, both directions. Q3a — split
 * an already-settled tax portion; never round CGST and SGST independently.
 * Any odd paise lands on CGST so the two always re-sum exactly.
 */
export function splitTax(taxPortionPaise: Paise, placeOfSupply: PlaceOfSupply): TaxSplit {
  assertNonNegativeInteger(taxPortionPaise, 'taxPortionPaise');
  if (placeOfSupply === 'inter_state') {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPortionPaise };
  }
  const cgstPaise = Math.round(taxPortionPaise / 2);
  const sgstPaise = taxPortionPaise - cgstPaise;
  return { cgstPaise, sgstPaise, igstPaise: 0 };
}

/** BR-033/Q3b — the only place the ₹5 tolerance is checked. No override parameter exists. */
export function isMargValueMatched(margValuePaise: Paise, soTotalPaise: Paise): boolean {
  return Math.abs(margValuePaise - soTotalPaise) <= MARG_TOLERANCE_PAISE;
}

/**
 * WF-11/BR-021 — the desk absorbs a dearer fallback rate up to the lower of
 * 1% of order value and the margin already on the line. Zero margin is the
 * hard maximum; there is no escalation path past it.
 *
 * NOTE both arguments must be on the SAME basis. Pass the inclusive SO total
 * and the margin expressed inclusive-of-GST, or both taxable — not one of
 * each.
 */
export function computeAbsorptionCapPaise(soTotalPaise: Paise, marginOnLinePaise: Paise): Paise {
  assertNonNegativeInteger(soTotalPaise, 'soTotalPaise');
  assertNonNegativeInteger(marginOnLinePaise, 'marginOnLinePaise');
  const onePercentOfOrder = Math.round(soTotalPaise * 0.01);
  return Math.min(onePercentOfOrder, marginOnLinePaise);
}

/**
 * BR-010/DEC-023 — the PO release gate. Named for what it checks, not
 * hard-coded to "paid", so a credit-line branch can be added later without a
 * state-machine rewrite. Credit is provisioned and switched off: this
 * function only ever evaluates the cleared-funds side today.
 */
export function isPaymentSatisfied(postedReceiptsPaise: Paise, soTotalPaise: Paise): boolean {
  assertNonNegativeInteger(postedReceiptsPaise, 'postedReceiptsPaise');
  assertNonNegativeInteger(soTotalPaise, 'soTotalPaise');
  return postedReceiptsPaise >= soTotalPaise;
}
