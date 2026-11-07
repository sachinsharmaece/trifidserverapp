/**
 * The pricing engine. BUSINESS_RULES.md §4, §17.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY RATE IS GST-INCLUSIVE. Read this before changing anything in here.
 *
 * The seller's quote, the margin, and the buyer's rate are all on one basis:
 *
 *   SELLER → TriFid    INCLUSIVE. The rate he quotes already includes GST
 *                                 (the 3 Nov rule for a product's own margin,
 *                                 extended to every quote on 6 Nov — DEC-077).
 *                                 The bill he raises is that figure split
 *                                 backwards into taxable value and GST.
 *
 *   TriFid → BUYER     INCLUSIVE. Confirmed by the client 13 Sep 2026
 *                                 (DEC-045, QR-002 corrected): "the rate
 *                                 shown is already the final tax-inclusive
 *                                 amount; nothing is added at checkout."
 *
 * So GST is never added to a rate anywhere. The margin — a % of the class
 * matrix or a product's own rupee amount — is added to the quote as it
 * stands, and GST only ever appears as the portion recovered BACKWARDS from
 * an inclusive total, for the Marg proforma and the bill.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HISTORY. Until 13 Sep 2026 the buyer's rate was taxable with GST added on
 * top. From then until 7 Nov 2026 the seller's rate was taxable and the
 * buyer's was `taxable × (1 + margin) × 1.18`. DEC-077 (7 Nov) made the
 * seller's quote inclusive, so the `× 1.18` went from both sides. The
 * seller-side and buyer-side functions stay separately named, so a misuse is
 * still a compile error.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ORDER OF OPERATIONS (CH §8.2 — margin applies to the seller's FOR-Indore
 * quote):
 *
 *   sellerRate             per base unit, FOR Indore, GST included
 *   buyerRate            = sellerRate × (1 + margin %)   or   sellerRate + ₹ margin
 *   taxable (bill/proforma) = total × 100 / 118, GST = total − taxable
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

/**
 * `baseUnitsPerBox` can be fractional: a 350 ML pack of 30 is 0.35 LTR × 30 = 10.5 litres a box.
 * Boxes and the per-unit rate stay whole numbers; the product is rounded to whole paise once.
 * For a whole-number `baseUnitsPerBox` this is exactly `boxes × baseUnitsPerBox × rate`.
 */
function assertQuantityPerBox(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number, got ${value}`);
  }
}

function extendedPaise(boxes: number, baseUnitsPerBox: number, ratePaise: Paise): Paise {
  return Math.round(boxes * baseUnitsPerBox * ratePaise);
}

/* ══════════════════════════════════════════════════════════════════════════
   BUYER SIDE — rates are GST-INCLUSIVE (DEC-045)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * BR-040/BR-045 — the buyer's rate, ready to display and to freeze onto a
 * sales-order line. The class matrix's margin is a percentage of the seller's
 * quote, which already includes GST, so no GST is added: a ₹150 quote with a
 * 5% margin is ₹157.50.
 *
 * `marginPct` is a decimal fraction (0.02 for 2%), never negative —
 * BR-021/CH §10.19.4: a negative-margin line is impossible by construction,
 * so this throws rather than producing one. At zero margin the result is the
 * seller's quote exactly.
 */
export function computeBuyerInclusiveRatePaise(sellerQuotePaise: Paise, marginPct: number): Paise {
  assertNonNegativeInteger(sellerQuotePaise, 'sellerQuotePaise');
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new TypeError(
      `marginPct must be >= 0, got ${marginPct}. A negative margin is an alarm, not a value (BR-021).`,
    );
  }
  return Math.round(sellerQuotePaise * (1 + marginPct));
}

/**
 * A product's own rupee margin (`product_margin_matrix`). The seller's quoted rate already
 * includes GST, and so does this rupee amount, so the buyer's rate is simply `quote + margin` —
 * no GST is added on either. A ₹150 quote with a ₹2 margin is ₹152. The class matrix works the
 * same way with a percentage. Never negative.
 */
export function computeBuyerInclusiveRatePaiseWithRupeeMargin(
  sellerRatePaise: Paise,
  marginPaise: Paise,
): Paise {
  assertNonNegativeInteger(sellerRatePaise, 'sellerRatePaise');
  assertNonNegativeInteger(marginPaise, 'marginPaise');
  return sellerRatePaise + marginPaise;
}

/** The margin a buyer's rate is built from: the class matrix's % or a product's own ₹. */
export type BuyerMargin = { kind: 'percent'; pct: number } | { kind: 'rupees'; marginPaise: Paise };

export function computeBuyerRatePaiseWithMargin(sellerNetPaise: Paise, margin: BuyerMargin): Paise {
  return margin.kind === 'rupees'
    ? computeBuyerInclusiveRatePaiseWithRupeeMargin(sellerNetPaise, margin.marginPaise)
    : computeBuyerInclusiveRatePaise(sellerNetPaise, margin.pct);
}

/**
 * The margin as a fraction of the seller's rate — what `marginPctAtOrder` freezes, so a rupee
 * margin still reads as a comparable percentage: ₹2 on a ₹150 quote is 1.33%.
 */
export function marginPctOf(sellerNetPaise: Paise, margin: BuyerMargin): number {
  if (margin.kind === 'percent') return margin.pct;
  if (sellerNetPaise <= 0) return 0;
  return Number((margin.marginPaise / sellerNetPaise).toFixed(6));
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
  assertQuantityPerBox(baseUnitsPerBox, 'baseUnitsPerBox');
  assertNonNegativeInteger(inclusiveRatePaise, 'inclusiveRatePaise');

  const totalPaise = extendedPaise(boxes, baseUnitsPerBox, inclusiveRatePaise);
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
   SELLER SIDE — the quoted rate is GST-INCLUSIVE too (DEC-077)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The seller's line, as it appears on the bill he raises to TriFid and on the
 * PO. His quoted rate includes GST, so the total is exactly boxes × units ×
 * rate — what TriFid pays — and the taxable value and GST are recovered from
 * it backwards. The same maths as the buyer's line, kept under its own name so
 * the two directions stay separately callable. Before 7 Nov 2026 the rate was
 * taxable and GST was added on top.
 */
export function computeSellerLineMoney(
  boxes: number,
  baseUnitsPerBox: number,
  inclusiveRatePaise: Paise,
  placeOfSupply: PlaceOfSupply,
): LineMoney {
  return computeBuyerLineMoney(boxes, baseUnitsPerBox, inclusiveRatePaise, placeOfSupply);
}

/**
 * Gross a taxable figure up by GST. For a figure that is explicitly taxable —
 * a debit note, a freight recovery. Never call this with a rate or a line
 * total: both sides' rates already include GST (DEC-045, DEC-077).
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

/** BR-055 — quantity is transacted in boxes. Whole paise (rounded once if a box holds a fraction of a unit). Direction-neutral. */
export function computeExtendedValuePaise(
  boxes: number,
  baseUnitsPerBox: number,
  ratePaise: Paise,
): Paise {
  assertNonNegativeInteger(boxes, 'boxes');
  assertQuantityPerBox(baseUnitsPerBox, 'baseUnitsPerBox');
  assertNonNegativeInteger(ratePaise, 'ratePaise');
  return extendedPaise(boxes, baseUnitsPerBox, ratePaise);
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
