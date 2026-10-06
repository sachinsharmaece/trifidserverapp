import type { Types } from 'mongoose';
import { Listing } from '../../../models/Listing.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Product } from '../../../models/Product.js';
import { Manufacturer } from '../../../models/Manufacturer.js';
import { Sku } from '../../../models/Sku.js';
import { So } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Ask } from '../../../models/Ask.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { AppError } from '../../../shared/errors.js';
import {
  computeBuyerFacingRatePaise,
  listPricedLinesVisibleToBuyerDoc,
} from '../../listing/listing.service.js';
import { asksOnProductFilter } from '../../demand/askScope.js';
import type { RateTier } from '../../pricing/pricing.service.js';

const DEFAULT_TIER: RateTier = 'Retailer';

/**
 * BR-060 — Sales never reads a listing line's own `ratePaise` (the seller's
 * net) directly; every rate shown here goes through the same buyer-facing
 * pricing function the buyer feed itself uses. Sales is not always acting
 * for one real buyer, so a bare tier name is turned into the minimal
 * buyer-shaped object `computeBuyerFacingRatePaise` actually reads
 * (`isTrader`/`tradePosition` — see `chain.service.ts`'s `toRateTier`),
 * rather than reimplementing the margin lookup for a "no buyer" case.
 */
function buyerShapedForTier(tier: RateTier): InstanceType<typeof Buyer> {
  const isTrader = tier === 'Trader';
  const tradePosition = isTrader
    ? null
    : (tier.toLowerCase() as 'distributor' | 'dealer' | 'retailer');
  return { isTrader, tradePosition } as unknown as InstanceType<typeof Buyer>;
}

async function rateForTierOrBuyer(
  skuId: Types.ObjectId | string,
  sellerNetPaise: number,
  opts: { tier?: RateTier; buyerId?: string },
): Promise<number | null> {
  if (opts.buyerId) {
    const buyer = await Buyer.findById(opts.buyerId);
    if (!buyer) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'Buyer not found.',
        field: 'buyerId',
      });
    }
    return computeBuyerFacingRatePaise(buyer, skuId, sellerNetPaise);
  }
  return computeBuyerFacingRatePaise(
    buyerShapedForTier(opts.tier ?? DEFAULT_TIER),
    skuId,
    sellerNetPaise,
  );
}

export interface BoardProductRow {
  productId: string;
  brand: string;
  technicalName: string;
  manufacturerName: string;
  ladderCount: number;
  cheapestRatePaise: number | null;
  buyerCount: number;
}

/** GET /staff/sales/board — every product with at least one live listing line. */
export async function getBoardProducts(): Promise<BoardProductRow[]> {
  const liveListings = await Listing.find({ state: 'live' });
  const liveListingIds = liveListings.map((l) => l._id);
  const productIdByListingId = new Map(
    liveListings.map((l) => [
      (l._id as Types.ObjectId).toString(),
      (l.productId as Types.ObjectId).toString(),
    ]),
  );
  const lines = await ListingLine.find({ listingId: { $in: liveListingIds }, qty: { $gt: 0 } });

  const linesByProduct = new Map<string, InstanceType<typeof ListingLine>[]>();
  for (const line of lines) {
    const productId = productIdByListingId.get((line.listingId as Types.ObjectId).toString());
    if (!productId) continue;
    const group = linesByProduct.get(productId) ?? [];
    group.push(line);
    linesByProduct.set(productId, group);
  }
  if (linesByProduct.size === 0) return [];

  const productIds = [...linesByProduct.keys()];
  const products = await Product.find({ _id: { $in: productIds } });
  const manufacturers = await Manufacturer.find({
    _id: { $in: products.map((p) => p.manufacturerId) },
  });
  const manufacturerNameById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m.name]),
  );

  // Order count as a cheap proxy for reach — via so_line's own skuId, not an exact live count (spec allows an approximation here).
  const allSoLines = await SoLine.find({}).select('soId skuId');
  const skus = await Sku.find({ productId: { $in: productIds } });
  const skuIdsByProduct = new Map<string, Set<string>>();
  for (const sku of skus) {
    const productId = (sku.productId as Types.ObjectId).toString();
    const set = skuIdsByProduct.get(productId) ?? new Set<string>();
    set.add((sku._id as Types.ObjectId).toString());
    skuIdsByProduct.set(productId, set);
  }
  const soIdToBuyerId = new Map(
    (await So.find({}).select('buyerId')).map((so) => [
      (so._id as Types.ObjectId).toString(),
      (so.buyerId as Types.ObjectId).toString(),
    ]),
  );

  const rows: BoardProductRow[] = [];
  for (const [productId, productLines] of linesByProduct) {
    const product = products.find((p) => (p._id as Types.ObjectId).toString() === productId);
    if (!product) continue;
    const skuIds = skuIdsByProduct.get(productId) ?? new Set<string>();
    const buyerIds = new Set<string>();
    for (const soLine of allSoLines) {
      if (!skuIds.has((soLine.skuId as Types.ObjectId).toString())) continue;
      const buyerId = soIdToBuyerId.get((soLine.soId as Types.ObjectId).toString());
      if (buyerId) buyerIds.add(buyerId);
    }

    let cheapestRatePaise: number | null = null;
    for (const line of productLines) {
      const rate = await rateForTierOrBuyer(line.skuId, line.ratePaise, {});
      if (rate === null) continue;
      if (cheapestRatePaise === null || rate < cheapestRatePaise) cheapestRatePaise = rate;
    }

    rows.push({
      productId,
      brand: product.brand,
      technicalName: product.technical,
      manufacturerName:
        manufacturerNameById.get((product.manufacturerId as Types.ObjectId).toString()) ?? '',
      ladderCount: productLines.length,
      cheapestRatePaise,
      buyerCount: buyerIds.size,
    });
  }
  return rows;
}

/**
 * One row of "On the board for him" — a product with every priced line that reaches the
 * buyer's tehsil. Audience-typed for Sales: no seller identity (no sellerId, firm or area),
 * and the rate is the buyer's own tier rate (BR-060), never a seller's net.
 */
export interface BoardForBuyerLine {
  listingLineId: string;
  skuId: string;
  packLabel: string;
  ratePaise: number;
  qty: number;
  expiryBand: string;
  moqBand: string;
  deliveryBand: string;
  provenance: string;
}

export interface BoardForBuyerProduct {
  productId: string;
  brand: string;
  technicalName: string;
  manufacturerName: string;
  ladder: BoardForBuyerLine[];
}

/**
 * GET /staff/sales/buyers/:buyerId/board — client item 16: "On the board for him" is
 * everything available for him to buy, which is what reaches his tehsil. It is never his
 * order history, so a buyer with no orders sees the same board as one with a hundred.
 */
export async function getBoardForBuyer(buyerDocId: string): Promise<BoardForBuyerProduct[]> {
  const priced = await listPricedLinesVisibleToBuyerDoc(buyerDocId);
  if (priced.length === 0) return [];

  const productIds = [
    ...new Set(priced.map((p) => (p.listing.productId as Types.ObjectId).toString())),
  ];
  const products = await Product.find({ _id: { $in: productIds } });
  const manufacturers = await Manufacturer.find({
    _id: { $in: products.map((p) => p.manufacturerId) },
  });
  const manufacturerNameById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m.name]),
  );
  const skus = await Sku.find({ _id: { $in: priced.map((p) => p.line.skuId) } });
  const packLabelBySkuId = new Map(
    skus.map((s) => [(s._id as Types.ObjectId).toString(), s.packLabel]),
  );

  const rows: BoardForBuyerProduct[] = [];
  for (const product of products) {
    const productId = (product._id as Types.ObjectId).toString();
    const ladder: BoardForBuyerLine[] = priced
      .filter((p) => (p.listing.productId as Types.ObjectId).toString() === productId)
      .map((p) => ({
        listingLineId: (p.line._id as Types.ObjectId).toString(),
        skuId: (p.line.skuId as Types.ObjectId).toString(),
        packLabel: packLabelBySkuId.get((p.line.skuId as Types.ObjectId).toString()) ?? '',
        ratePaise: p.buyerRatePaise,
        qty: p.line.qty,
        expiryBand: p.line.expiryBand,
        moqBand: p.line.moqBand,
        deliveryBand: p.line.deliveryBand,
        provenance: p.line.provenance,
      }))
      .sort((a, b) => a.ratePaise - b.ratePaise);
    rows.push({
      productId,
      brand: product.brand,
      technicalName: product.technical,
      manufacturerName:
        manufacturerNameById.get((product.manufacturerId as Types.ObjectId).toString()) ?? '',
      ladder,
    });
  }
  return rows.sort((a, b) => a.ladder[0]!.ratePaise - b.ladder[0]!.ratePaise);
}

export interface BoardLadderLine {
  listingLineId: string;
  skuId: string;
  packLabel: string;
  ratePaise: number | null;
  qty: number;
  expiryBand: string;
  moqBand: string;
  deliveryBand: string;
  provenance: string;
  tehsilCount: number;
}

export interface BoardOpenAsk {
  askId: string;
  buyerId: string;
  buyerFirm: string;
  skuId: string | null;
  qty: number;
  state: string;
  createdAt: string;
}

export interface BuyerProductHistoryEntry {
  soId: string;
  soNo: string;
  state: string;
  totalPaise: number;
  createdAt: string;
}

export interface BoardProductDetail {
  productId: string;
  brand: string;
  technicalName: string;
  manufacturerName: string;
  ladder: BoardLadderLine[];
  openAsks: BoardOpenAsk[];
  buyerHistory?: BuyerProductHistoryEntry[];
}

/** GET /staff/sales/board/:productId — the full rate ladder for one product. */
export async function getBoardProduct(
  productId: string,
  opts: { tier?: RateTier; buyerId?: string },
): Promise<BoardProductDetail> {
  const product = await Product.findById(productId);
  if (!product) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  const manufacturer = await Manufacturer.findById(product.manufacturerId);

  const skus = await Sku.find({ productId: product._id });
  const skuIds = skus.map((s) => s._id);
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));

  const liveListings = await Listing.find({ productId: product._id, state: 'live' });
  const listingIds = liveListings.map((l) => l._id);
  const lines = await ListingLine.find({
    listingId: { $in: listingIds },
    skuId: { $in: skuIds },
    qty: { $gt: 0 },
  });

  const ladder: BoardLadderLine[] = [];
  for (const line of lines) {
    const listing = liveListings.find(
      (l) => (l._id as Types.ObjectId).toString() === (line.listingId as Types.ObjectId).toString(),
    );
    const sku = skuById.get((line.skuId as Types.ObjectId).toString());
    const ratePaise = await rateForTierOrBuyer(line.skuId, line.ratePaise, opts);
    ladder.push({
      listingLineId: (line._id as Types.ObjectId).toString(),
      skuId: (line.skuId as Types.ObjectId).toString(),
      packLabel: sku?.packLabel ?? '',
      ratePaise,
      qty: line.qty,
      expiryBand: line.expiryBand,
      moqBand: line.moqBand,
      deliveryBand: line.deliveryBand,
      provenance: line.provenance,
      tehsilCount: listing?.frozenTehsilIds.length ?? 0,
    });
  }
  ladder.sort((a, b) => (a.ratePaise ?? Infinity) - (b.ratePaise ?? Infinity));

  // A pack-specific ask has no productId of its own — match it through its SKU too.
  const openAsks = await Ask.find({
    ...asksOnProductFilter(product._id as Types.ObjectId, skuIds as Types.ObjectId[]),
    state: { $nin: ['lapsed', 'withdrawn'] },
  }).sort({ createdAt: -1 });

  // B-27 — the demand table showed a raw truncated buyer id as the only
  // identifier, never the firm.
  const askBuyers = await Buyer.find({ _id: { $in: openAsks.map((a) => a.buyerId) } });
  const askBuyerCounterparties = await Counterparty.find({
    _id: { $in: askBuyers.map((b) => b.counterpartyId) },
  });
  const askFirmByCounterpartyId = new Map(
    askBuyerCounterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '']),
  );
  const askFirmByBuyerId = new Map(
    askBuyers.map((b) => [
      (b._id as Types.ObjectId).toString(),
      askFirmByCounterpartyId.get((b.counterpartyId as Types.ObjectId).toString()) ?? '',
    ]),
  );

  const detail: BoardProductDetail = {
    productId: (product._id as Types.ObjectId).toString(),
    brand: product.brand,
    technicalName: product.technical,
    manufacturerName: manufacturer?.name ?? '',
    ladder,
    openAsks: openAsks.map((a) => ({
      askId: (a._id as Types.ObjectId).toString(),
      buyerId: (a.buyerId as Types.ObjectId).toString(),
      buyerFirm: askFirmByBuyerId.get((a.buyerId as Types.ObjectId).toString()) ?? '',
      skuId: a.skuId ? (a.skuId as Types.ObjectId).toString() : null,
      qty: a.qty,
      state: a.state,
      createdAt: (a as unknown as { createdAt: Date }).createdAt.toISOString(),
    })),
  };

  if (opts.buyerId) {
    const soLines = await SoLine.find({ skuId: { $in: skuIds } });
    const soIds = soLines.map((l) => l.soId);
    const sos = await So.find({ _id: { $in: soIds }, buyerId: opts.buyerId }).sort({
      createdAt: -1,
    });
    detail.buyerHistory = sos.map((so) => ({
      soId: (so._id as Types.ObjectId).toString(),
      soNo: so.soNo,
      state: so.state,
      totalPaise: so.totalPaise,
      createdAt: (so as unknown as { createdAt: Date }).createdAt.toISOString(),
    }));
  }

  return detail;
}
