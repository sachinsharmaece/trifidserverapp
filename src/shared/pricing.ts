/**
 * M4 pricing engine. BUSINESS_RULES.md §4, §17; QUESTION_REGISTER.md QR-001/
 * QR-002/QR-003, answered by the client 6 Sep 2026 (see DECISION_LOG.md
 * DEC-026 onward). This is the one module that computes money from a rate —
 * every other module calls in here rather than repeating the formula.
 *
 * Working assumption, not a quoted Charter formula: the client confirmed
 * "rates per base unit" (Q1), "GST added on top, taxable rate" (Q2) and
 * "GST never rounded, only the final amount is rounded" (Q3a). Combining
 * those with CH §8.2 (margin applies to landed cost, i.e. the seller's
 * FOR-Indore quoted rate) and CH §10.21 (GST is a pass-through) gives the
 * formula below. Flag this to the client for one-line confirmation before it
 * is treated as load-bearing beyond this milestone.
 *
 * Every function here is pure and works in integer paise. A rate is itself a
 * monetary value (DATA_MODEL.md §2.3), so it is quantized to the nearest
 * paise when it is frozen onto an order line — that is a one-time rate
 * rounding, not the GST rounding Q3a governs. GST itself is carried at full
 * precision through the calculation and only the final total is rounded
 * (Q3a) — the tax split (CGST+SGST or IGST) is then a division of that
 * already-rounded total, never an independent rounding of each component.
 */

import type { Paise } from './money.js';

export const GST_RATE_PERCENT = 18;

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
  /** Exact — boxes × baseUnitsPerBox × ratePaise is always an integer product of integers. */
  taxablePaise: Paise;
  /** The document total: round once, at the total, per Q3a. */
  totalPaise: Paise;
  /** totalPaise − taxablePaise. Always exact, always non-negative. */
  taxPortionPaise: Paise;
  taxSplit: TaxSplit;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * BR-045/TD-003 — a rate on a buyer's screen (and every stored rate) is an
 * integer number of paise. Margin is applied here, once, at the moment the
 * rate is frozen onto an order line. `marginPct` is a decimal fraction
 * (0.0572 for 5.72%), never negative — BR-021/CH §10.19.4: a negative-margin
 * line is impossible by construction, so this throws rather than producing
 * one.
 */
export function computeBuyerRatePaise(sellerNetPaise: Paise, marginPct: number): Paise {
  assertNonNegativeInteger(sellerNetPaise, 'sellerNetPaise');
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new TypeError(
      `marginPct must be >= 0, got ${marginPct}. A negative margin is an alarm, not a value (BR-021).`,
    );
  }
  return Math.round(sellerNetPaise * (1 + marginPct));
}

/** BR-055 — quantity is transacted in boxes; the taxable value is exact, never rounded. */
export function computeTaxablePaise(
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
 * Q3a — GST is carried at full precision (taxablePaise × 118, an exact
 * integer, divided by 100) and only the resulting total is rounded, once.
 * `taxPortionPaise` is then recovered by subtraction, so it always re-sums
 * to `totalPaise` exactly — there is no independently-rounded GST figure
 * anywhere in this module.
 */
export function computeTotalWithGst(taxablePaise: Paise): {
  totalPaise: Paise;
  taxPortionPaise: Paise;
} {
  assertNonNegativeInteger(taxablePaise, 'taxablePaise');
  const totalPaise = Math.round((taxablePaise * (100 + GST_RATE_PERCENT)) / 100);
  return { totalPaise, taxPortionPaise: totalPaise - taxablePaise };
}

/**
 * BR-300 — place of supply decides the split, both directions. Q3a — split
 * the already-rounded tax portion; never round CGST and SGST independently.
 * Any odd paise from the 50/50 split lands on CGST so the two always re-sum
 * to `taxPortionPaise` exactly.
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

/** The one function every document-line calculation should call. */
export function computeLineMoney(
  boxes: number,
  baseUnitsPerBox: number,
  ratePaise: Paise,
  placeOfSupply: PlaceOfSupply,
): LineMoney {
  const taxablePaise = computeTaxablePaise(boxes, baseUnitsPerBox, ratePaise);
  const { totalPaise, taxPortionPaise } = computeTotalWithGst(taxablePaise);
  return {
    taxablePaise,
    totalPaise,
    taxPortionPaise,
    taxSplit: splitTax(taxPortionPaise, placeOfSupply),
  };
}

/** BR-033/Q3b — the only place the ₹5 tolerance is checked. No override parameter exists. */
export function isMargValueMatched(margValuePaise: Paise, soTotalPaise: Paise): boolean {
  return Math.abs(margValuePaise - soTotalPaise) <= MARG_TOLERANCE_PAISE;
}

/**
 * WF-11/BR-021 — the desk absorbs a dearer fallback rate up to the lower of
 * 1% of order value and the margin already on the line. Zero margin is the
 * hard maximum; there is no escalation path past it (enforced by the caller
 * never invoking this with a negative `marginOnLinePaise`).
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
