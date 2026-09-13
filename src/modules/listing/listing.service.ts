import type { Types } from 'mongoose';
import { Listing, type ListingScopeType } from '../../models/Listing.js';
import {
  ListingLine,
  deriveMoqBand,
  type DeliveryBand,
  type ExpiryBand,
  type MoqBand,
  type Provenance,
} from '../../models/ListingLine.js';
import { Seller } from '../../models/Seller.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { Buyer } from '../../models/Buyer.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Tehsil } from '../../models/Tehsil.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { Pool, buildConditionSetKey } from '../../models/Pool.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { BuyerLocation } from '../../models/BuyerLocation.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import type { Paise } from '../../shared/money.js';
import { computeBuyerRatePaise } from '../../shared/pricing.js';
import { resolveMarginMatrixCell } from '../pricing/pricing.service.js';
import { resolveSkuClass, toRateTier } from '../chain/chain.service.js';
import { resolveVisibility, type SellerBlockLookup } from '../territory/resolver.js';

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
const LISTING_LIFE_DAYS = 45; // BR-108.

/**
 * BR-060/BR-006 — a buyer is never shown a seller's net rate. Every
 * buyer-facing read (feed, product offers, buy screen) computes this
 * buyer's own tier-marked-up rate fresh, the same margin-matrix mechanism
 * `chain.service.ts` uses at order time (`BR-048`) — never the listing
 * line's own `ratePaise`, which is the seller's net (`BR-124`). Returns
 * `null` (never throws) when the matrix has no cell for this class/tier
 * yet, so one missing cell excludes an offer rather than 500ing the whole
 * feed — the hard refusal (`MARGIN_CELL_MISSING`) stays reserved for the
 * moment an order is actually placed.
 */
export async function computeBuyerFacingRatePaise(
  buyer: InstanceType<typeof Buyer>,
  skuId: Types.ObjectId | string,
  sellerNetPaise: Paise,
): Promise<Paise | null> {
  try {
    const { skuClass } = await resolveSkuClass(skuId);
    const tier = toRateTier(buyer);
    const cell = await resolveMarginMatrixCell(skuClass, tier);
    return computeBuyerRatePaise(sellerNetPaise, cell.pct);
  } catch (error) {
    if (error instanceof AppError && error.code === 'MARGIN_CELL_MISSING') return null;
    throw error;
  }
}

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

async function sellerBlockLookupFor(sellerId: Types.ObjectId): Promise<SellerBlockLookup> {
  const blocks = await SellerBlock.find({ sellerId, status: 'active' }).select('gstin');
  const blockedGstins = new Set(blocks.map((b) => b.gstin));
  return (gstin: string) => blockedGstins.has(gstin);
}

async function resolveFrozenTehsilIds(
  sellerId: Types.ObjectId,
  scopeType: ListingScopeType,
  customTehsilIds?: string[],
): Promise<Types.ObjectId[]> {
  const ownAreaIds = (await SellerArea.find({ sellerId }).select('tehsilId')).map(
    (a) => a.tehsilId as Types.ObjectId,
  );

  if (scopeType === 'my_area') return ownAreaIds;

  if (scopeType === 'all_india') {
    const all = await Tehsil.find({}).select('_id');
    return all.map((t) => t._id as Types.ObjectId);
  }

  if (scopeType === 'all_except_mine') {
    const ownSet = new Set(ownAreaIds.map((id) => id.toString()));
    const all = await Tehsil.find({}).select('_id');
    return all.map((t) => t._id as Types.ObjectId).filter((id) => !ownSet.has(id.toString()));
  }

  // custom
  if (!customTehsilIds || customTehsilIds.length === 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A custom scope requires at least one tehsil.',
      field: 'customTehsilIds',
    });
  }
  const found = await Tehsil.find({ _id: { $in: customTehsilIds } }).select('_id');
  if (found.length !== customTehsilIds.length) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'One or more tehsils in the custom scope do not exist.',
      field: 'customTehsilIds',
    });
  }
  return found.map((t) => t._id as Types.ObjectId);
}

interface CreateListingLineInput {
  skuId: string;
  ratePaise: Paise;
  expiryBand: ExpiryBand;
  expiryExact?: string;
  moqExact?: number; // BR-150 — the seller sets this; defaults to 1 (no pool).
  deliveryBand: DeliveryBand;
  provenance: Provenance;
  batch?: string;
  qty: number;
}

interface CreateListingInput {
  productId: string;
  scopeType: ListingScopeType;
  customTehsilIds?: string[];
  lines: CreateListingLineInput[];
}

function assertShelfLifeMeetsFloor(expiryBand: ExpiryBand, expiryExact: string | undefined): void {
  // BR-107 — six clear months, enforced at listing time. `expiryExact` is an
  // expectation (BR-102), but when a seller does supply one up front it is
  // still checked against the floor rather than accepted blindly.
  if (!expiryExact) return;
  const [monthStr, yearStr] = expiryExact.split('/');
  const month = Number(monthStr);
  const year = Number(yearStr);
  if (!month || !year) return;
  const expiryDate = new Date(year, month - 1, 1);
  if (expiryDate.getTime() - Date.now() < SIX_MONTHS_MS) {
    throw new AppError({
      code: 'SHELF_LIFE_FLOOR',
      messageEn: 'A listing under six months of remaining shelf life cannot be created (BR-107).',
      field: 'expiryExact',
    });
  }
}

function assertProvenanceDeliveryMatch(provenance: Provenance, deliveryBand: DeliveryBand): void {
  // BR-104 — provenance constrains which delivery band is selectable.
  const allowed: Record<Provenance, DeliveryBand> = { auth: '48h', company: '2-5d' };
  if (allowed[provenance] !== deliveryBand) {
    throw new AppError({
      code: 'PROVENANCE_DELIVERY_MISMATCH',
      messageEn: `Provenance "${provenance}" only allows the "${allowed[provenance]}" delivery band.`,
      field: 'deliveryBand',
    });
  }
}

function assertBatchRequiredForAuth(provenance: Provenance, batch: string | undefined): void {
  // BR-105 — batch is mandatory only on `auth` (My stock) listings.
  if (provenance === 'auth' && !batch) {
    throw new AppError({
      code: 'BATCH_REQUIRED',
      messageEn: 'Batch is required for "My stock" listings (BR-105).',
      field: 'batch',
    });
  }
}

/** API-033. BR-083 — no area, no listing. BR-113 — one rate per ticked pack. */
export async function createListing(
  sellerCounterpartyId: string,
  input: CreateListingInput,
): Promise<{ listingId: string; lineIds: string[] }> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });

  const ownAreaCount = await SellerArea.countDocuments({ sellerId: seller._id });
  if (ownAreaCount === 0) {
    throw new AppError({
      code: 'NO_AREA_SET',
      messageEn: 'You have no area set yet — contact Purchase before listing (BR-083).',
    });
  }

  if (input.lines.length === 0) {
    throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'At least one pack is required.' });
  }
  for (const line of input.lines) {
    assertShelfLifeMeetsFloor(line.expiryBand, line.expiryExact);
    assertProvenanceDeliveryMatch(line.provenance, line.deliveryBand);
    assertBatchRequiredForAuth(line.provenance, line.batch);
    const sku = await Sku.findOne({ _id: line.skuId, productId: input.productId });
    if (!sku) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'One or more SKUs do not belong to this product.',
        field: 'skuId',
      });
    }
  }

  const frozenTehsilIds = await resolveFrozenTehsilIds(
    seller._id as Types.ObjectId,
    input.scopeType,
    input.customTehsilIds,
  );

  const now = new Date();
  const listing = await Listing.create({
    productId: input.productId,
    sellerId: seller._id,
    origin: 'seller_initiated',
    scopeType: input.scopeType,
    frozenTehsilIds, // BR-085 — frozen now, never a live reference to the seller's area.
    state: 'live',
    expiresAt: new Date(now.getTime() + LISTING_LIFE_DAYS * 24 * 60 * 60 * 1000),
    lastConfirmedAt: now,
  });

  const lineIds: string[] = [];
  for (const line of input.lines) {
    const moqExact = line.moqExact ?? 1;
    const moqBand = deriveMoqBand(moqExact);
    const created = await ListingLine.create({
      listingId: listing._id,
      skuId: line.skuId,
      ratePaise: line.ratePaise,
      expiryBand: line.expiryBand,
      expiryExact: line.expiryExact ?? null,
      expiryFixed: false, // IC-01/BR-102 — the exact month never displays until confirmation.
      moqExact,
      deliveryBand: line.deliveryBand,
      provenance: line.provenance,
      batch: line.batch ?? null,
      qty: line.qty,
    });
    lineIds.push((created._id as Types.ObjectId).toString());

    // BR-150/BR-151 — any MOQ above 1 opens (or joins) a pool on this SKU's condition-set key.
    if (moqExact > 1) {
      await openOrJoinPool(line.skuId, moqExact, {
        expiryBand: line.expiryBand,
        moqBand,
        deliveryBand: line.deliveryBand,
        provenance: line.provenance,
      });
    }
  }

  return { listingId: (listing._id as Types.ObjectId).toString(), lineIds };
}

async function openOrJoinPool(
  skuId: string,
  moqExact: number,
  key: { expiryBand: string; moqBand: MoqBand; deliveryBand: string; provenance: string },
): Promise<void> {
  const conditionSetKey = buildConditionSetKey(key);
  const existing = await Pool.findOne({ skuId, conditionSetKey, isActive: true });
  if (existing) return; // BR-151 — a pool belongs to the condition set, not to one seller's listing.
  await Pool.create({
    skuId,
    conditionSetKey,
    expiryBand: key.expiryBand,
    moqBand: key.moqBand,
    deliveryBand: key.deliveryBand,
    provenance: key.provenance,
    moq: moqExact, // BR-150 — the seller-specified number, not a band-derived guess.
    status: 'open',
    isActive: true,
  });
}

interface MyListingLineItem {
  listingId: string;
  listingLineId: string;
  skuId: string;
  packLabel: string;
  ratePaise: Paise;
  qty: number;
  expiryBand: string;
  moqBand: string;
  deliveryBand: string;
  provenance: string;
  state: string;
  expiresAt: Date;
  daysRemaining: number;
}

/** API-034. My stock — listings with days remaining, filterable by origin and state. */
export async function getMyListings(
  sellerCounterpartyId: string,
  filters: { state?: string },
): Promise<MyListingLineItem[]> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });

  const query: Record<string, unknown> = { sellerId: seller._id };
  if (filters.state) query.state = filters.state;
  const listings = await Listing.find(query).sort({ createdAt: -1 });
  const listingIds = listings.map((l) => l._id);
  const lines = await ListingLine.find({ listingId: { $in: listingIds } });
  const listingById = new Map(listings.map((l) => [(l._id as Types.ObjectId).toString(), l]));
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));

  const now = Date.now();
  return lines.map((line) => {
    const listing = listingById.get((line.listingId as Types.ObjectId).toString())!;
    const sku = skuById.get((line.skuId as Types.ObjectId).toString());
    return {
      listingId: (listing._id as Types.ObjectId).toString(),
      listingLineId: (line._id as Types.ObjectId).toString(),
      skuId: (line.skuId as Types.ObjectId).toString(),
      packLabel: sku?.packLabel ?? '',
      ratePaise: line.ratePaise,
      qty: line.qty,
      expiryBand: line.expiryBand,
      moqBand: line.moqBand,
      deliveryBand: line.deliveryBand,
      provenance: line.provenance,
      state: listing.state,
      expiresAt: listing.expiresAt,
      daysRemaining: Math.max(
        0,
        Math.ceil((listing.expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)),
      ),
    };
  });
}

/** API-036 pause. */
export async function pauseListing(sellerCounterpartyId: string, listingId: string): Promise<void> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  const listing = await Listing.findOne({ _id: listingId, sellerId: seller?._id });
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
  listing.state = 'paused';
  listing.pausedAt = new Date();
  await listing.save();
}

/** API-036 relist — BR-108, one tap, history preserved (a fresh 45-day window on the same listing). */
export async function relistListing(
  sellerCounterpartyId: string,
  listingId: string,
): Promise<void> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  const listing = await Listing.findOne({ _id: listingId, sellerId: seller?._id });
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
  listing.state = 'live';
  listing.pausedAt = null;
  listing.expiresAt = new Date(Date.now() + LISTING_LIFE_DAYS * 24 * 60 * 60 * 1000);
  await listing.save();
}

interface ChangeRateInput {
  ratePaise: Paise;
  doubleConfirmed?: boolean;
}

/** API-035. BR-109 — gated by size, not direction. */
export async function changeListingLineRate(
  sellerCounterpartyId: string,
  listingLineId: string,
  input: ChangeRateInput,
  actor: StaffActor,
): Promise<{ heldOutOfBenchmark: boolean }> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  const line = await ListingLine.findById(listingLineId);
  if (!line) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });
  const listing = await Listing.findOne({ _id: line.listingId, sellerId: seller?._id });
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });

  const oldRate = line.ratePaise;
  const isDecrease = input.ratePaise < oldRate;
  const changePct = isDecrease ? (oldRate - input.ratePaise) / oldRate : 0;
  let heldOutOfBenchmark = false;

  if (isDecrease && changePct > 0.02) {
    if (!input.doubleConfirmed) {
      throw new AppError({
        code: 'DOUBLE_CONFIRM_REQUIRED',
        messageEn: 'A cut beyond 2% must be confirmed twice on your own device (BR-109).',
      });
    }
    heldOutOfBenchmark = true; // ⚠️ QR-022 — reviewer and SLA still open; held out until a human reviews it.
  }

  line.ratePaise = input.ratePaise;
  line.version += 1;
  await line.save();

  await writeAuditLog({
    actorId: seller!.counterpartyId as unknown as Types.ObjectId,
    actorType: 'counterparty',
    entity: 'listing_line',
    entityId: line._id as Types.ObjectId,
    field: 'ratePaise',
    oldValue: oldRate,
    newValue: input.ratePaise,
    correlationId: actor.correlationId,
  });

  return { heldOutOfBenchmark };
}

// ---------------------------------------------------------------------------
// Buyer-facing reads — BR-060: never a sellerId, never a sellerNet.
// ---------------------------------------------------------------------------

async function requireActiveBuyer(buyerCounterpartyId: string) {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  if (!buyer.tehsilId) {
    throw new AppError({
      code: 'NO_AREA_SET',
      messageEn: 'Your tehsil is not yet set — contact support.',
    });
  }
  const counterparty = await Counterparty.findById(buyer.counterpartyId);
  return { buyer, counterparty: counterparty! };
}

interface VisibleLine {
  line: InstanceType<typeof ListingLine>;
  listing: InstanceType<typeof Listing>;
}

interface PricedVisibleLine extends VisibleLine {
  buyerRatePaise: Paise;
}

/** Attaches this buyer's own tier rate to each line, dropping any whose class/tier cell is still missing. */
async function priceForBuyer(
  buyer: InstanceType<typeof Buyer>,
  lines: VisibleLine[],
): Promise<PricedVisibleLine[]> {
  const priced = await Promise.all(
    lines.map(async (v) => {
      const buyerRatePaise = await computeBuyerFacingRatePaise(
        buyer,
        v.line.skuId,
        v.line.ratePaise,
      );
      return buyerRatePaise === null ? null : { ...v, buyerRatePaise };
    }),
  );
  return priced.filter((v): v is PricedVisibleLine => v !== null);
}

/**
 * WF-03 — the one resolver, called here and nowhere else for buyer reads.
 * Loads every live line whose frozen tehsil set contains the buyer's
 * tehsil (the resolver's hot path, indexed), then re-checks
 * `resolveVisibility` per listing for the self-dealing and block cases the
 * index alone cannot express.
 */
async function findVisibleLines(
  buyerTehsilId: string,
  buyerCounterpartyId: string,
  buyerGstin: string,
): Promise<VisibleLine[]> {
  const listings = await Listing.find({ state: 'live', frozenTehsilIds: buyerTehsilId });
  const sellerIds = [...new Set(listings.map((l) => (l.sellerId as Types.ObjectId).toString()))];
  const sellers = await Seller.find({ _id: { $in: sellerIds } });
  const sellerCounterpartyById = new Map(
    sellers.map((s) => [
      (s._id as Types.ObjectId).toString(),
      (s.counterpartyId as Types.ObjectId).toString(),
    ]),
  );
  const blockLookups = new Map<string, SellerBlockLookup>();
  for (const sellerId of sellerIds) {
    blockLookups.set(sellerId, await sellerBlockLookupFor(sellerId as unknown as Types.ObjectId));
  }

  const visibleListings = listings.filter((listing) => {
    const sellerId = (listing.sellerId as Types.ObjectId).toString();
    const sellerCounterpartyId = sellerCounterpartyById.get(sellerId);
    if (!sellerCounterpartyId) return false;
    return resolveVisibility(
      {
        sellerId: sellerCounterpartyId,
        frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
      },
      { gstin: buyerGstin, tehsilId: buyerTehsilId, counterpartyId: buyerCounterpartyId },
      blockLookups.get(sellerId)!,
    );
  });

  const listingById = new Map(
    visibleListings.map((l) => [(l._id as Types.ObjectId).toString(), l]),
  );
  const lines = await ListingLine.find({
    listingId: { $in: visibleListings.map((l) => l._id) },
    qty: { $gt: 0 },
  });
  return lines
    .filter((line) => listingById.has((line.listingId as Types.ObjectId).toString()))
    .map((line) => ({
      line,
      listing: listingById.get((line.listingId as Types.ObjectId).toString())!,
    }));
}

interface BuyerConditionTagsDto {
  expiryBand: string;
  moqBand: string;
  deliveryBand: string;
  provenance: string;
  // IC-01/BR-102 — never present unless the seller has confirmed supply.
  expiryExact?: string;
}

function toConditionTags(line: InstanceType<typeof ListingLine>): BuyerConditionTagsDto {
  return {
    expiryBand: line.expiryBand,
    moqBand: line.moqBand,
    deliveryBand: line.deliveryBand,
    provenance: line.provenance,
    ...(line.expiryFixed && line.expiryExact ? { expiryExact: line.expiryExact } : {}),
  };
}

export interface BuyerFeedCard {
  productId: string;
  brand: string;
  technical: string;
  lowestRatePaise: Paise;
  conditions: BuyerConditionTagsDto;
  offerCount: number;
}

/** API-030. BR-110 — one card per product, cheapest first, newest groups first. */
export async function getBuyerFeed(
  buyerCounterpartyId: string,
  cursor: number,
  limit: number,
): Promise<{ items: BuyerFeedCard[]; nextCursor?: number }> {
  const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
  const visible = await findVisibleLines(
    (buyer.tehsilId as Types.ObjectId).toString(),
    buyerCounterpartyId,
    counterparty.gstin ?? '',
  );
  const priced = await priceForBuyer(buyer, visible);

  const productIds = [
    ...new Set(priced.map((v) => (v.listing.productId as Types.ObjectId).toString())),
  ];
  const products = await Product.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));

  const byProduct = new Map<string, PricedVisibleLine[]>();
  for (const v of priced) {
    const productId = (v.listing.productId as Types.ObjectId).toString();
    const group = byProduct.get(productId) ?? [];
    group.push(v);
    byProduct.set(productId, group);
  }

  const cards: BuyerFeedCard[] = [];
  for (const [productId, lines] of byProduct) {
    const product = productById.get(productId);
    if (!product) continue;
    const cheapest = lines.reduce((min, v) => (v.buyerRatePaise < min.buyerRatePaise ? v : min));
    cards.push({
      productId,
      brand: product.brand,
      technical: product.technical,
      lowestRatePaise: cheapest.buyerRatePaise,
      conditions: toConditionTags(cheapest.line),
      offerCount: lines.length,
    });
  }

  // Newest groups first (BR-110) — approximated by the newest listing in each group.
  cards.sort((a, b) => {
    const aLatest = Math.max(
      ...(byProduct.get(a.productId) ?? []).map((v) => v.listing.createdAt!.getTime()),
    );
    const bLatest = Math.max(
      ...(byProduct.get(b.productId) ?? []).map((v) => v.listing.createdAt!.getTime()),
    );
    return bLatest - aLatest;
  });

  const page = cards.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < cards.length ? cursor + limit : undefined;
  return { items: page, nextCursor };
}

export interface BuyerOfferDto {
  listingLineId: string;
  ratePaise: Paise;
  conditions: BuyerConditionTagsDto;
  hasPool: boolean;
}

/** API-031. Every rate on a product, cheapest first, plus pools on that product. */
export async function getProductOffers(
  buyerCounterpartyId: string,
  productId: string,
): Promise<{
  offers: BuyerOfferDto[];
  pools: Array<{ poolId: string; skuId: string; moq: number; status: string }>;
}> {
  const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
  const visible = await findVisibleLines(
    (buyer.tehsilId as Types.ObjectId).toString(),
    buyerCounterpartyId,
    counterparty.gstin ?? '',
  );
  const priced = await priceForBuyer(
    buyer,
    visible.filter((v) => (v.listing.productId as Types.ObjectId).toString() === productId),
  );
  priced.sort((a, b) => a.buyerRatePaise - b.buyerRatePaise);

  const skuIds = [...new Set(priced.map((v) => (v.line.skuId as Types.ObjectId).toString()))];
  const pools = await Pool.find({ skuId: { $in: skuIds }, isActive: true });

  return {
    offers: priced.map((v) => ({
      listingLineId: (v.line._id as Types.ObjectId).toString(),
      ratePaise: v.buyerRatePaise,
      conditions: toConditionTags(v.line),
      hasPool: pools.some(
        (p) =>
          (p.skuId as Types.ObjectId).toString() === (v.line.skuId as Types.ObjectId).toString(),
      ),
    })),
    pools: pools.map((p) => ({
      poolId: (p._id as Types.ObjectId).toString(),
      skuId: (p.skuId as Types.ObjectId).toString(),
      moq: p.moq,
      status: p.status,
    })),
  };
}

export interface BuyScreenDto {
  listingLineId: string;
  productId: string;
  brand: string;
  packLabel: string;
  baseUnit: string;
  baseUnitsPerBox: number;
  ratePaise: Paise; // This buyer's own tier rate — never the seller's net (BR-060).
  moqExact: number;
  availableBoxes: number;
  conditions: BuyerConditionTagsDto;
}

/** API-032. The buy screen. Server-side visibility re-checked, never trusted from a link. */
export async function getListingLineForBuy(
  buyerCounterpartyId: string,
  listingLineId: string,
): Promise<BuyScreenDto> {
  const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
  const line = await ListingLine.findById(listingLineId);
  const listing = line ? await Listing.findById(line.listingId) : null;

  // WF-03 — a direct link to something outside scope returns the same
  // shape and the same latency as something that does not exist (BR-065).
  if (!line || !listing || listing.state !== 'live') {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }
  const seller = await Seller.findById(listing.sellerId);
  const blockLookup = await sellerBlockLookupFor(listing.sellerId as Types.ObjectId);
  const visible = resolveVisibility(
    {
      sellerId: (seller!.counterpartyId as Types.ObjectId).toString(),
      frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
    },
    {
      gstin: counterparty.gstin ?? '',
      tehsilId: (buyer.tehsilId as Types.ObjectId).toString(),
      counterpartyId: buyerCounterpartyId,
    },
    blockLookup,
  );
  if (!visible) {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }

  const sku = await Sku.findById(line.skuId);
  const product = await Product.findById(listing.productId);
  const ratePaise = await computeBuyerFacingRatePaise(buyer, line.skuId, line.ratePaise);
  if (ratePaise === null) {
    // QR-007 — no matrix cell for this buyer's class/tier yet; nothing to
    // show him a price for. Same shape as "not visible" rather than a 500.
    throw new AppError({
      code: 'MARGIN_CELL_MISSING',
      messageEn: 'This offer is not priced for your account yet.',
    });
  }

  return {
    listingLineId: (line._id as Types.ObjectId).toString(),
    productId: (listing.productId as Types.ObjectId).toString(),
    brand: product?.brand ?? '',
    packLabel: sku?.packLabel ?? '',
    baseUnit: sku?.baseUnit ?? '',
    baseUnitsPerBox: sku?.baseUnitsPerBox ?? 0,
    ratePaise,
    moqExact: line.moqExact,
    availableBoxes: line.qty,
    conditions: toConditionTags(line),
  };
}

interface InquireInput {
  qty: number;
  deliveryLocationId: string;
}

/**
 * New — not in the original `API_CONTRACT.md`, needed to actually submit
 * WF-04's buy screen (API-032 only describes the read). BR-093 — the
 * delivery location is not constrained by the listing's scope; an
 * out-of-scope delivery only raises a monitoring flag, it blocks nothing.
 * Creates a `pile` on first request against a line (BR-133); nothing is
 * charged and no clock runs against the seller.
 */
export async function createPileRequest(
  buyerCounterpartyId: string,
  listingLineId: string,
  input: InquireInput,
): Promise<{ pileId: string }> {
  const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
  const line = await ListingLine.findById(listingLineId);
  const listing = line ? await Listing.findById(line.listingId) : null;
  if (!line || !listing || listing.state !== 'live') {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }
  const seller = await Seller.findById(listing.sellerId);
  const blockLookup = await sellerBlockLookupFor(listing.sellerId as Types.ObjectId);
  const visible = resolveVisibility(
    {
      sellerId: (seller!.counterpartyId as Types.ObjectId).toString(),
      frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
    },
    {
      gstin: counterparty.gstin ?? '',
      tehsilId: (buyer.tehsilId as Types.ObjectId).toString(),
      counterpartyId: buyerCounterpartyId,
    },
    blockLookup,
  );
  if (!visible) throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });

  if (input.qty < line.moqExact) {
    throw new AppError({
      code: 'BELOW_MOQ',
      messageEn: `Minimum order for this line is ${line.moqExact} boxes.`,
      field: 'qty',
    });
  }
  const location = await BuyerLocation.findOne({
    _id: input.deliveryLocationId,
    buyerId: buyer._id,
    deletedAt: null,
  });
  if (!location) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Delivery location not found.',
      field: 'deliveryLocationId',
    });
  }

  let pile = await Pile.findOne({ listingLineId: line._id });
  if (!pile) {
    pile = await Pile.create({
      listingLineId: line._id,
      confirmWindowEndsAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // BR-135 default confirm_window_h.
    });
  } else if (pile.decision) {
    throw new AppError({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: 'This listing has already been decided.',
    });
  }

  await PileRequest.create({
    pileId: pile._id,
    buyerId: buyer._id,
    qty: input.qty,
    deliveryLocationId: location._id,
  });

  return { pileId: (pile._id as Types.ObjectId).toString() };
}

/** Read-only for buyers (BR-094 — staff add locations, never self-serve). */
export async function listMyDeliveryLocations(
  buyerCounterpartyId: string,
): Promise<Array<{ locationId: string; label: string; address: string; isPrimary: boolean }>> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  const locations = await BuyerLocation.find({ buyerId: buyer._id, deletedAt: null });
  return locations.map((l) => ({
    locationId: (l._id as Types.ObjectId).toString(),
    label: l.label,
    address: l.address,
    isPrimary: l.isPrimary,
  }));
}

// ---------------------------------------------------------------------------
// Seller-facing reads — BR-061/BR-062: rank and bands, never a rate.
// ---------------------------------------------------------------------------

const MIN_COMPARABLE = 3; // BR-062 — below this, the band does not render at all.

export interface PositionCardDto {
  rank?: number;
  ofCount?: number;
  gapBand?: 'ahead' | 'competitive' | 'behind';
  band?: { lowPaise: Paise; highPaise: Paise; listingCount: number };
  suppressed: boolean;
}

/** API-037. BR-062 — trailing clearance band, never live; suppressed below `min_comparable`. */
export async function getPositionCard(
  sellerCounterpartyId: string,
  listingLineId: string,
): Promise<PositionCardDto> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  const line = await ListingLine.findById(listingLineId);
  const listing = line
    ? await Listing.findOne({ _id: line.listingId, sellerId: seller?._id })
    : null;
  if (!line || !listing)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });

  const comparableListings = await Listing.find({ productId: listing.productId, state: 'live' });
  const comparableLines = await ListingLine.find({
    listingId: { $in: comparableListings.map((l) => l._id) },
    skuId: line.skuId,
    expiryBand: line.expiryBand,
    moqBand: line.moqBand,
    deliveryBand: line.deliveryBand,
    provenance: line.provenance,
  }).sort({ ratePaise: 1 });

  if (comparableLines.length < MIN_COMPARABLE) {
    return { suppressed: true };
  }

  const rank =
    comparableLines.findIndex((l) => (l._id as Types.ObjectId).toString() === listingLineId) + 1;
  const lowPaise = comparableLines[0]!.ratePaise;
  const highPaise = comparableLines[comparableLines.length - 1]!.ratePaise;
  const gapBand =
    rank === 1 ? 'ahead' : rank <= Math.ceil(comparableLines.length / 2) ? 'competitive' : 'behind';

  return {
    rank,
    ofCount: comparableLines.length,
    gapBand,
    band: { lowPaise, highPaise, listingCount: comparableLines.length },
    suppressed: false,
  };
}

/** API-038. Never a name, never a rate — counts only. */
export async function getBoardOpportunities(): Promise<
  Array<{ skuId: string; conditionSetKey: string; sellerCount: number }>
> {
  const lines = await ListingLine.find({});
  const listings = await Listing.find({ state: 'live' });
  const listingSellerById = new Map(
    listings.map((l) => [
      (l._id as Types.ObjectId).toString(),
      (l.sellerId as Types.ObjectId).toString(),
    ]),
  );

  const groups = new Map<string, Set<string>>();
  for (const line of lines) {
    const sellerId = listingSellerById.get((line.listingId as Types.ObjectId).toString());
    if (!sellerId) continue;
    const key = `${(line.skuId as Types.ObjectId).toString()}|${buildConditionSetKey(line)}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(sellerId);
    groups.set(key, set);
  }

  return [...groups.entries()].map(([key, sellers]) => {
    const [skuId, conditionSetKey] = key.split('|') as [string, string];
    return { skuId, conditionSetKey, sellerCount: sellers.size };
  });
}
