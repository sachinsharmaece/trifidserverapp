import type { Types } from 'mongoose';
import { MarginMatrix, type MarginMatrixDocument } from '../../models/MarginMatrix.js';
import { AppError } from '../../shared/errors.js';
import type { HydratedDocument } from 'mongoose';

export type SkuClass = 'A' | 'B' | 'C';
export type RateTier = 'Distributor' | 'Dealer' | 'Retailer' | 'Trader';

/**
 * BR-040/BR-046 — the cell that applies is the one with the latest
 * `effectiveFrom` that is not in the future. BR-046: effective-dating is
 * forward only, so this is a simple "latest row not after now" read, never
 * an edit. Throws MARGIN_CELL_MISSING rather than falling back to a default
 * or zero — a missing cell is a configuration failure, not a free trade
 * (QR-007 remains open; this is what "refuses to price" looks like).
 */
export async function resolveMarginMatrixCell(
  skuClass: SkuClass,
  tier: RateTier,
  asOf: Date = new Date(),
): Promise<HydratedDocument<MarginMatrixDocument>> {
  const cell = await MarginMatrix.findOne({
    class: skuClass,
    tier,
    effectiveFrom: { $lte: asOf },
  }).sort({ effectiveFrom: -1 });

  if (!cell) {
    throw new AppError({
      code: 'MARGIN_CELL_MISSING',
      messageEn: `No margin matrix cell is configured for class ${skuClass} / tier ${tier}. QR-007 — the twelve values are not yet supplied.`,
    });
  }
  return cell;
}

export interface MarginMatrixCellDto {
  marginMatrixId: string;
  class: SkuClass;
  tier: RateTier;
  pct: number;
  creditPct: number;
  effectiveFrom: Date;
}

function toDto(doc: HydratedDocument<MarginMatrixDocument>): MarginMatrixCellDto {
  return {
    marginMatrixId: doc.id as string,
    class: doc.class as SkuClass,
    tier: doc.tier as RateTier,
    pct: doc.pct,
    creditPct: doc.creditPct,
    effectiveFrom: doc.effectiveFrom,
  };
}

/** API-131. The twelve cells currently in effect, one row per class × tier. */
export async function getCurrentMarginMatrix(
  asOf: Date = new Date(),
): Promise<MarginMatrixCellDto[]> {
  const classes: SkuClass[] = ['A', 'B', 'C'];
  const tiers: RateTier[] = ['Distributor', 'Dealer', 'Retailer', 'Trader'];
  const results: MarginMatrixCellDto[] = [];
  for (const skuClass of classes) {
    for (const tier of tiers) {
      const cell = await MarginMatrix.findOne({
        class: skuClass,
        tier,
        effectiveFrom: { $lte: asOf },
      }).sort({ effectiveFrom: -1 });
      if (cell) results.push(toDto(cell));
    }
  }
  return results;
}

interface SetMarginMatrixCellInput {
  class: SkuClass;
  tier: RateTier;
  pct: number;
  creditPct?: number;
  effectiveFrom: Date;
}

/**
 * API-131 PUT. BR-046 — forward-dated only: this always inserts a new row,
 * never updates one in place, so an already-placed order (whose line froze
 * its own values, BR-045) can never be moved by a later edit here. That
 * invariant does not require `effectiveFrom` to be strictly in the future —
 * "effective immediately" is a normal forward-dated write too, and rejecting
 * it would only invite a race against the request's own network latency.
 * BR-016's maker-checker exception applies — "two people clicking accept on
 * a number a formula produced is theatre" — so a single Admin action is
 * sufficient here, unlike a payment batch.
 */
export async function setMarginMatrixCell(
  input: SetMarginMatrixCellInput,
  actor: { employeeId: string },
): Promise<MarginMatrixCellDto> {
  const created = await MarginMatrix.create({
    class: input.class,
    tier: input.tier,
    pct: input.pct,
    creditPct: input.creditPct ?? 0,
    effectiveFrom: input.effectiveFrom,
    createdBy: actor.employeeId as unknown as Types.ObjectId,
  });
  return toDto(created);
}
