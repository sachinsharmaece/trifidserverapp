import type { Types } from 'mongoose';
import { BUYER_TIERS, SKU_CLASSES, type BuyerTier, type SkuClass } from '../../shared/enums.js';
import { MarginCellModel } from '../../models/index.js';

/**
 * MADE-UP margins so the Margin matrix screen (and, later, pricing) can be tried before the client sends
 * the real ones (Q-PRC-07). Basis points: 2000 = 20%. Only B × Retailer = 20% comes from the prototype; the
 * rest are invented, rising from Trader to Retailer.
 */
const DEMO_MARGIN_BP: Record<SkuClass, Record<BuyerTier, number>> = {
  A: { TRADER: 500, DISTRIBUTOR: 800, DEALER: 1000, RETAILER: 1500 },
  B: { TRADER: 600, DISTRIBUTOR: 1000, DEALER: 1500, RETAILER: 2000 },
  C: { TRADER: 800, DISTRIBUTOR: 1200, DEALER: 1800, RETAILER: 2500 },
};

/**
 * Every made-up cell starts on this date (1 Jan 2026, Indian time) and nothing real does, so they are easy to
 * find. A real margin entered on the Margin matrix screen starts later and replaces it from then on.
 */
export const DEMO_MARGINS_START = new Date('2026-01-01T00:00:00+05:30');

/**
 * Adds a made-up margin for each class × tier that has no cell yet. A pair that already has any cell (real or
 * made-up) is left alone, so running this twice, or after real values were entered, changes nothing.
 */
export async function addDemoMargins(
  createdBy: Types.ObjectId,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const skuClass of SKU_CLASSES) {
    for (const buyerTier of BUYER_TIERS) {
      if (await MarginCellModel.exists({ skuClass, buyerTier })) {
        skipped++;
        continue;
      }
      await MarginCellModel.create({
        skuClass,
        buyerTier,
        marginBp: DEMO_MARGIN_BP[skuClass][buyerTier],
        effectiveFrom: DEMO_MARGINS_START,
        createdBy,
      });
      added++;
    }
  }
  return { added, skipped };
}
