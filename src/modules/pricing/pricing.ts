import { MarginCellModel, SkuMarginCellModel } from '../../models/index.js';
import type { BuyerTier, SkuClass } from '../../shared/enums.js';

/**
 * Pricing: how the rate a buyer sees is worked out. Every buyer-facing rate must come from `computeBuyerRate`
 * (SRS-PRC-01), so the board, quotes and orders can never disagree.
 */

/**
 * The rate for a buyer, per unit, in paise: the landed rate plus TriFid's margin on it (BR-03).
 * `marginBp` is in basis points (1500 = 15%). Example: landed ₹500.00 (50000) at 2000 bp gives 50000 + 10000 = ₹600.00.
 */
export function computeBuyerRate(landedPaisePerUnit: number, marginBp: number): number {
  return landedPaisePerUnit + Math.round((landedPaisePerUnit * marginBp) / 10_000);
}

/** The margin in use for each class × tier at one moment. `null` means no cell has started yet for that pair. */
export interface MarginTable {
  marginFor: (skuClass: SkuClass, tier: BuyerTier) => number | null;
  /**
   * The buyer's rate per unit for one pack (reference LOCK-39 resolveMargin): a live SKU price-matrix cell (₹ per
   * unit) wins; otherwise the Parent cell (class × tier, %). `null` when neither exists.
   */
  rateFor: (
    sku: { id: string; skuClass: SkuClass },
    tier: BuyerTier,
    landedPaisePerUnit: number,
  ) => number | null;
  /** Where the margin came from for this pack and tier: a SKU cell or the Parent. */
  sourceFor: (sku: { id: string; skuClass: SkuClass }, tier: BuyerTier) => 'SKU' | 'PARENT' | null;
}

/**
 * Reads the margin matrix once. For each class × tier the newest cell whose `effectiveFrom` has passed is used, so a
 * cell dated in the future is ignored until its day. Load it once per request, then look up as many rates as needed.
 */
export async function loadMargins(at: Date = new Date()): Promise<MarginTable> {
  const cells = await MarginCellModel.find({ effectiveFrom: { $lte: at } }).sort({
    effectiveFrom: -1,
  });
  const inUse = new Map<string, number>();
  for (const cell of cells) {
    const key = `${cell.skuClass}:${cell.buyerTier}`;
    if (!inUse.has(key)) inUse.set(key, cell.marginBp); // newest first, so the first one seen wins
  }
  // Live SKU cells: approved, started, not ended. The newest start wins.
  const skuCells = await SkuMarginCellModel.find({
    status: 'ACTIVE',
    effectiveFrom: { $lte: at },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $exists: false } },
      { effectiveTo: { $gte: at } },
    ],
  }).sort({ effectiveFrom: -1 });
  const skuInUse = new Map<string, number>();
  for (const cell of skuCells) {
    const key = `${String(cell.skuId)}:${cell.buyerTier}`;
    if (!skuInUse.has(key)) skuInUse.set(key, cell.marginPaisePerUnit);
  }
  const marginFor = (skuClass: SkuClass, tier: BuyerTier) =>
    inUse.get(`${skuClass}:${tier}`) ?? null;
  return {
    marginFor,
    rateFor: (sku, tier, landed) => {
      const perUnit = skuInUse.get(`${sku.id}:${tier}`);
      if (perUnit !== undefined) return landed + perUnit;
      const bp = marginFor(sku.skuClass, tier);
      return bp === null ? null : computeBuyerRate(landed, bp);
    },
    sourceFor: (sku, tier) =>
      skuInUse.has(`${sku.id}:${tier}`)
        ? 'SKU'
        : marginFor(sku.skuClass, tier) === null
          ? null
          : 'PARENT',
  };
}

/**
 * The tier a buyer is priced at. Until the buyer is classified the tier is only a guess, so the buyer is priced as
 * RETAILER and the rate is "indicative" (SRS-SAL-02).
 */
export function pricingTierOf(buyer: {
  rateTier: BuyerTier;
  classifiedAt?: Date | null | undefined;
}): {
  tier: BuyerTier;
  indicative: boolean;
} {
  return buyer.classifiedAt
    ? { tier: buyer.rateTier, indicative: false }
    : { tier: 'RETAILER', indicative: true };
}
