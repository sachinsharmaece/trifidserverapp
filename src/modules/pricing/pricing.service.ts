import type { Types } from 'mongoose';
import { MarginMatrix, type MarginMatrixDocument } from '../../models/MarginMatrix.js';
import { ProductMarginMatrix } from '../../models/ProductMarginMatrix.js';
import { Product } from '../../models/Product.js';
import { AppError } from '../../shared/errors.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import type { BuyerMargin } from '../../shared/pricing.js';
import type { HydratedDocument } from 'mongoose';

export type SkuClass = 'High' | 'Medium' | 'Low';
export type RateTier = 'Distributor' | 'Dealer' | 'Retailer' | 'Trader';

const RATE_TIERS: RateTier[] = ['Distributor', 'Dealer', 'Retailer', 'Trader'];

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

/**
 * BR-040 — the margin that prices a buyer of this tier on this product. A product's own rupee
 * cell wins; a product with no cell for the tier (or whose latest row is a "back to the class
 * matrix" null) falls back to the class percentage. Throws MARGIN_CELL_MISSING only when
 * neither exists.
 */
export async function resolveBuyerMargin(
  productId: Types.ObjectId | string,
  skuClass: SkuClass,
  tier: RateTier,
  asOf: Date = new Date(),
): Promise<BuyerMargin> {
  const own = await ProductMarginMatrix.findOne({
    productId,
    tier,
    effectiveFrom: { $lte: asOf },
  }).sort({ effectiveFrom: -1, createdAt: -1 });
  if (own && typeof own.marginPaise === 'number') {
    return { kind: 'rupees', marginPaise: own.marginPaise };
  }
  const cell = await resolveMarginMatrixCell(skuClass, tier, asOf);
  return { kind: 'percent', pct: cell.pct };
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
  const classes: SkuClass[] = ['High', 'Medium', 'Low'];
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

interface SetMarginMatrixBulkInput {
  cells: Array<{ class: SkuClass; tier: RateTier; pct: number; creditPct?: number }>;
  effectiveFrom: Date;
}

/**
 * API-132. Saves several cells under one `effectiveFrom` in a single
 * `insertMany`, so the admin screen never leaves a half-applied matrix
 * behind. Still forward-only (BR-046): every cell is a new row. Mongoose
 * validates every document before the write is sent, so one bad cell
 * rejects the whole batch.
 */
export async function setMarginMatrixBulk(
  input: SetMarginMatrixBulkInput,
  actor: { employeeId: string },
): Promise<MarginMatrixCellDto[]> {
  const seen = new Set<string>();
  for (const cell of input.cells) {
    const key = `${cell.class}/${cell.tier}`;
    if (seen.has(key)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `Cell ${key} appears more than once in this save.`,
      });
    }
    seen.add(key);
  }
  const created = await MarginMatrix.insertMany(
    input.cells.map((cell) => ({
      class: cell.class,
      tier: cell.tier,
      pct: cell.pct,
      creditPct: cell.creditPct ?? 0,
      effectiveFrom: input.effectiveFrom,
      createdBy: actor.employeeId as unknown as Types.ObjectId,
    })),
  );
  return created.map((doc) => toDto(doc as HydratedDocument<MarginMatrixDocument>));
}

export interface MarginMatrixHistoryRowDto extends MarginMatrixCellDto {
  createdAt: Date;
}

/**
 * API-133. Every row ever written, newest `effectiveFrom` first — including
 * rows dated in the future, which `getCurrentMarginMatrix` does not show yet.
 */
export async function getMarginMatrixHistory(limit = 200): Promise<MarginMatrixHistoryRowDto[]> {
  const rows = await MarginMatrix.find().sort({ effectiveFrom: -1, createdAt: -1 }).limit(limit);
  return rows.map((doc) => ({
    ...toDto(doc as HydratedDocument<MarginMatrixDocument>),
    createdAt: (doc as unknown as { createdAt: Date }).createdAt,
  }));
}

// ---------------------------------------------------------------------------
// A product's own rupee margin (`product_margin_matrix`)
// ---------------------------------------------------------------------------

export interface ProductMarginRowDto {
  productMarginId: string;
  productId: string;
  tier: RateTier;
  /** GST-inclusive paise per base unit; `null` is a "back to the class matrix" row. */
  marginPaise: number | null;
  effectiveFrom: Date;
  createdAt: Date;
}

function toProductMarginDto(doc: {
  id?: string;
  productId: unknown;
  tier: string;
  marginPaise?: number | null;
  effectiveFrom: Date;
  createdAt?: Date;
}): ProductMarginRowDto {
  return {
    productMarginId: doc.id as string,
    productId: String(doc.productId),
    tier: doc.tier as RateTier,
    marginPaise: doc.marginPaise ?? null,
    effectiveFrom: doc.effectiveFrom,
    createdAt: doc.createdAt as Date,
  };
}

async function assertProductExists(productId: string): Promise<void> {
  assertValidObjectId(productId, 'productId');
  if (!(await Product.exists({ _id: productId }))) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  }
}

/**
 * The rupee cells in effect now for one product, one per tier that has one. A tier with no row,
 * or whose latest row is a null, is left out: that tier is on the class matrix.
 */
export async function getCurrentProductMargin(
  productId: string,
  asOf: Date = new Date(),
): Promise<ProductMarginRowDto[]> {
  await assertProductExists(productId);
  const results: ProductMarginRowDto[] = [];
  for (const tier of RATE_TIERS) {
    const row = await ProductMarginMatrix.findOne({
      productId,
      tier,
      effectiveFrom: { $lte: asOf },
    }).sort({ effectiveFrom: -1, createdAt: -1 });
    if (row && typeof row.marginPaise === 'number') results.push(toProductMarginDto(row));
  }
  return results;
}

interface SetProductMarginInput {
  cells: Array<{ tier: RateTier; marginPaise: number | null }>;
  effectiveFrom: Date;
}

/**
 * Saves several tiers for one product under one `effectiveFrom`, in one `insertMany`. Forward
 * only (BR-046): every cell is a new row, and `marginPaise: null` is how a tier goes back to
 * the class matrix. Maker-checker does not apply, as for the class matrix (BR-016).
 */
export async function setProductMargin(
  productId: string,
  input: SetProductMarginInput,
  actor: { employeeId: string },
): Promise<ProductMarginRowDto[]> {
  await assertProductExists(productId);
  const seen = new Set<string>();
  for (const cell of input.cells) {
    if (seen.has(cell.tier)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `Tier ${cell.tier} appears more than once in this save.`,
      });
    }
    seen.add(cell.tier);
  }
  const created = await ProductMarginMatrix.insertMany(
    input.cells.map((cell) => ({
      productId,
      tier: cell.tier,
      marginPaise: cell.marginPaise,
      effectiveFrom: input.effectiveFrom,
      createdBy: actor.employeeId as unknown as Types.ObjectId,
    })),
  );
  return created.map((doc) => toProductMarginDto(doc));
}

/** Every row ever written for one product, newest `effectiveFrom` first, future-dated ones included. */
export async function getProductMarginHistory(
  productId: string,
  limit = 200,
): Promise<ProductMarginRowDto[]> {
  await assertProductExists(productId);
  const rows = await ProductMarginMatrix.find({ productId })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .limit(limit);
  return rows.map((doc) => toProductMarginDto(doc));
}
