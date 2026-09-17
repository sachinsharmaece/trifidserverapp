import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { Listing } from '../../../models/Listing.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Product } from '../../../models/Product.js';
import { Sku } from '../../../models/Sku.js';
import { SellerArea } from '../../../models/SellerArea.js';
import { Po } from '../../../models/Po.js';
import { PoLine } from '../../../models/PoLine.js';
import { SoLine } from '../../../models/SoLine.js';
import { So } from '../../../models/So.js';
import { Inspection } from '../../../models/Inspection.js';
import { ReturnNote } from '../../../models/ReturnNote.js';
import { PromotionOffer } from '../../../models/PromotionOffer.js';
import {
  NonOrderReason,
  SUPPLY_GAP_CODES,
  type SupplyGapCode,
} from '../../../models/NonOrderReason.js';
import { AppError } from '../../../shared/errors.js';

const RETURN_NOTE_WINDOW_DAYS = 30; // BR-189.

// ---------------------------------------------------------------------------
// Active demand list — BR-272's four seller states + the No-seller filter.
//
// Simplification, flagged: BR-272's states are properly scoped to sellers
// "in scope" for the buyer behind the ask, but an ask carries no tehsil at
// all by design (BR-064 — the wall). Resolving "in scope" would mean joining
// through to the buyer's own tehsil from a Purchase-facing read, which sits
// uncomfortably close to buyer identity in a low-density tehsil — so this
// reads "in scope" as "anywhere in the product/SKU's own market" instead:
// every seller who has ever quoted, listed or supplied this SKU. Flagged in
// the session report rather than guessed at silently.
// ---------------------------------------------------------------------------

export type SellerDemandState = 'quoted' | 'active' | 'dormant' | 'dark';

export interface ActiveDemandItem {
  askId: string;
  qty: number;
  skuId: string | null;
  productId: string | null;
  createdAt: string;
  sellerCounts: Record<SellerDemandState, number>; // Counts only — BR-067 (no buyer identity), BR-069 (no rupee figure).
  noSeller: boolean;
}

async function skuIdsForAsk(ask: InstanceType<typeof Ask>): Promise<Types.ObjectId[]> {
  if (ask.skuId) return [ask.skuId as Types.ObjectId];
  if (ask.productId) {
    const skus = await Sku.find({ productId: ask.productId });
    return skus.map((s) => s._id as Types.ObjectId);
  }
  return [];
}

export async function getActiveDemandList(filters: {
  noSellerOnly?: boolean;
}): Promise<ActiveDemandItem[]> {
  const asks = await Ask.find({ state: { $in: ['open', 'quoted'] } }).sort({ createdAt: -1 });
  const items: ActiveDemandItem[] = [];

  for (const ask of asks) {
    const skuIds = await skuIdsForAsk(ask);

    const quotedSellerIds = new Set(
      (await Quote.find({ askId: ask._id })).map((q) => (q.sellerId as Types.ObjectId).toString()),
    );

    const listingLines = skuIds.length ? await ListingLine.find({ skuId: { $in: skuIds } }) : [];
    const liveListings = skuIds.length
      ? await Listing.find({ _id: { $in: listingLines.map((l) => l.listingId) }, state: 'live' })
      : [];
    const activeSellerIds = new Set(
      liveListings
        .map((l) => (l.sellerId as Types.ObjectId).toString())
        .filter((id) => !quotedSellerIds.has(id)),
    );

    const soLines = skuIds.length ? await SoLine.find({ skuId: { $in: skuIds } }) : [];
    const sos = soLines.length ? await So.find({ _id: { $in: soLines.map((l) => l.soId) } }) : [];
    const everSuppliedSellerIds = new Set(
      sos
        .map((s) => (s.sellerId as Types.ObjectId).toString())
        .filter((id) => !quotedSellerIds.has(id) && !activeSellerIds.has(id)),
    );

    const sellerCounts: Record<SellerDemandState, number> = {
      quoted: quotedSellerIds.size,
      active: activeSellerIds.size,
      dormant: everSuppliedSellerIds.size,
      dark: 0, // No principled way to count "never engaged, but in scope" without buyer tehsil — see file header.
    };
    const noSeller = sellerCounts.quoted + sellerCounts.active + sellerCounts.dormant === 0;

    if (filters.noSellerOnly && !noSeller) continue;

    items.push({
      askId: (ask._id as Types.ObjectId).toString(),
      qty: ask.qty,
      skuId: ask.skuId ? (ask.skuId as Types.ObjectId).toString() : null,
      productId: ask.productId ? (ask.productId as Types.ObjectId).toString() : null,
      createdAt: (ask as unknown as { createdAt: Date }).createdAt.toISOString(),
      sellerCounts,
      noSeller,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Coded quote gaps (BR-273) — already computed at `postQuote` time
// (`demand.service.ts`'s `computeGapCodes`); this just surfaces it.
// ---------------------------------------------------------------------------

export interface AskQuoteGap {
  quoteId: string;
  sellerId: string;
  gapCodes: string[];
}

export async function getQuoteGapsForAsk(askId: string): Promise<AskQuoteGap[]> {
  const quotes = await Quote.find({ askId, status: 'live' }).sort({ ratePaiseForIndore: 1 });
  return quotes.map((q) => ({
    quoteId: (q._id as Types.ObjectId).toString(),
    sellerId: (q.sellerId as Types.ObjectId).toString(),
    gapCodes: q.gapCodes ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Coverage map — BR-274, keyed company × tehsil, not by technical.
// ---------------------------------------------------------------------------

export interface CoverageCell {
  manufacturerId: string;
  tehsilId: string;
  sellerCount: number;
}

/** Two sources per cell is BR-274's target; this returns the raw count, the desk reads the target against it. */
export async function getCoverageMap(): Promise<CoverageCell[]> {
  const areas = await SellerArea.find({});
  const products = await Product.find({ active: true });
  const skus = await Sku.find({ productId: { $in: products.map((p) => p._id) } });
  const listingLines = await ListingLine.find({ skuId: { $in: skus.map((s) => s._id) } });
  const liveListings = await Listing.find({
    _id: { $in: listingLines.map((l) => l.listingId) },
    state: 'live',
  });

  const skuToManufacturer = new Map(
    skus.map((s) => {
      const product = products.find((p) => (p._id as Types.ObjectId).equals(s.productId));
      return [(s._id as Types.ObjectId).toString(), product?.manufacturerId?.toString() ?? null];
    }),
  );
  const lineToManufacturer = new Map(
    listingLines.map((l) => [
      (l._id as Types.ObjectId).toString(),
      skuToManufacturer.get((l.skuId as Types.ObjectId).toString()) ?? null,
    ]),
  );
  const sellerToManufacturers = new Map<string, Set<string>>();
  for (const listing of liveListings) {
    const lines = listingLines.filter((l) => l.listingId.equals(listing._id as Types.ObjectId));
    const sellerId = (listing.sellerId as Types.ObjectId).toString();
    for (const line of lines) {
      const manufacturerId = lineToManufacturer.get((line._id as Types.ObjectId).toString());
      if (!manufacturerId) continue;
      if (!sellerToManufacturers.has(sellerId)) sellerToManufacturers.set(sellerId, new Set());
      sellerToManufacturers.get(sellerId)!.add(manufacturerId);
    }
  }

  const cellCounts = new Map<string, number>();
  for (const area of areas) {
    const sellerId = (area.sellerId as Types.ObjectId).toString();
    const manufacturerIds = sellerToManufacturers.get(sellerId);
    if (!manufacturerIds) continue;
    for (const manufacturerId of manufacturerIds) {
      const key = `${manufacturerId}::${area.tehsilId.toString()}`;
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }

  return [...cellCounts.entries()].map(([key, sellerCount]) => {
    const [manufacturerId, tehsilId] = key.split('::');
    return { manufacturerId: manufacturerId!, tehsilId: tehsilId!, sellerCount };
  });
}

// ---------------------------------------------------------------------------
// Product analysis — CH §18.8's arithmetic identities.
//
// BUSINESS_RULES.md has no extracted BR-### for "position split"/"rejection
// split" — MASTER_PLAN.md cites CH §18.8 by number but the passage was never
// pulled into BUSINESS_RULES.md. This session's own reading, flagged rather
// than invented: "position split" = boxes ordered, split by the buyer's
// trade position at order time (`SoLine`/`So.tierAtOrder`), which must sum
// to the product's total boxes ordered; "rejection split" = accepted vs.
// rejected cases at inspection, which must sum to cases inspected.
// ---------------------------------------------------------------------------

export interface ProductAnalysis {
  productId: string;
  totalBoxesOrdered: number;
  positionSplit: Record<'Distributor' | 'Dealer' | 'Retailer' | 'Trader', number>;
  positionSplitSumsCorrectly: boolean;
  totalCasesInspected: number;
  rejectionSplit: { accepted: number; rejected: number };
  rejectionSplitSumsCorrectly: boolean;
}

export async function getProductAnalysis(productId: string): Promise<ProductAnalysis> {
  const skus = await Sku.find({ productId });
  const skuIds = skus.map((s) => s._id as Types.ObjectId);
  const soLines = await SoLine.find({ skuId: { $in: skuIds } });
  const sos = await So.find({ _id: { $in: soLines.map((l) => l.soId) } });
  const soById = new Map(sos.map((s) => [(s._id as Types.ObjectId).toString(), s]));

  const positionSplit: ProductAnalysis['positionSplit'] = {
    Distributor: 0,
    Dealer: 0,
    Retailer: 0,
    Trader: 0,
  };
  let totalBoxesOrdered = 0;
  for (const line of soLines) {
    const so = soById.get((line.soId as Types.ObjectId).toString());
    if (!so) continue;
    positionSplit[so.tierAtOrder as keyof typeof positionSplit] += line.boxes;
    totalBoxesOrdered += line.boxes;
  }
  const positionSplitSum = Object.values(positionSplit).reduce((a, b) => a + b, 0);

  const poLines = await PoLine.find({ skuId: { $in: skuIds } });
  const pos = await Po.find({ _id: { $in: poLines.map((l) => l.poId) } });
  const inspections = await Inspection.find({ poId: { $in: pos.map((p) => p._id) } });
  const accepted = inspections.reduce((sum, i) => sum + i.casesAccepted, 0);
  const rejected = inspections.reduce((sum, i) => sum + i.casesRejected, 0);

  // The real identity: every case on an *inspected* lot is accepted or
  // rejected — nothing vanishes. Compared against the ordered quantity on
  // exactly those PO lines that were actually inspected, not every PO line
  // on the product (an un-inspected lot has nothing to reconcile against).
  const poLineByPoId = new Map(poLines.map((l) => [l.poId.toString(), l]));
  const inspectedBoxesOrdered = inspections.reduce((sum, i) => {
    const line = poLineByPoId.get(i.poId.toString());
    return sum + (line?.boxes ?? 0);
  }, 0);

  return {
    productId,
    totalBoxesOrdered,
    positionSplit,
    positionSplitSumsCorrectly: positionSplitSum === totalBoxesOrdered,
    totalCasesInspected: accepted + rejected,
    rejectionSplit: { accepted, rejected },
    rejectionSplitSumsCorrectly: accepted + rejected === inspectedBoxesOrdered,
  };
}

// ---------------------------------------------------------------------------
// Absorption queue — IC-06. Never the cap, never the two source rates.
// ---------------------------------------------------------------------------

export interface AbsorptionQueueItem {
  soId: string;
  status: string;
  deltaPaise: number;
  withinCap: boolean;
  offeredAt: string;
  expiresAt: string;
}

export async function getAbsorptionQueue(): Promise<AbsorptionQueueItem[]> {
  const offers = await PromotionOffer.find({}).sort({ offeredAt: -1 });
  return offers.map((o) => ({
    soId: o.soId.toString(),
    status: o.status,
    deltaPaise: o.deltaPaise,
    withinCap: o.withinCap,
    offeredAt: o.offeredAt.toISOString(),
    expiresAt: o.expiresAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Non-order reasons — BR-269. Purchase records the supply-gap bucket only.
// ---------------------------------------------------------------------------

export async function recordSupplyGapReason(
  input: { askId?: string; pileId?: string; code: SupplyGapCode },
  actor: { employeeId: string },
): Promise<{ nonOrderReasonId: string }> {
  if (!SUPPLY_GAP_CODES.includes(input.code)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Not a recognised supply-gap code.',
    });
  }
  const row = await NonOrderReason.create({
    askId: input.askId ?? null,
    pileId: input.pileId ?? null,
    bucket: 'supply_gap',
    code: input.code,
    recordedBy: actor.employeeId,
  });
  return { nonOrderReasonId: (row._id as Types.ObjectId).toString() };
}

// ---------------------------------------------------------------------------
// Return-note ageing — BR-189's 30-day clock. QR-021 leaves day 31 open;
// this only reports age, it does not decide what happens past it.
// ---------------------------------------------------------------------------

export interface ReturnNoteAgeingItem {
  returnNoteId: string;
  poId: string;
  cases: number;
  daysOld: number;
  overdue: boolean; // Past the 30-day window — QR-021, not resolved here.
}

export async function getReturnNoteAgeing(): Promise<ReturnNoteAgeingItem[]> {
  const notes = await ReturnNote.find({ returnedAt: null }).sort({ raisedAt: 1 });
  const now = Date.now();
  return notes.map((n) => {
    const daysOld = Math.floor((now - n.raisedAt.getTime()) / (24 * 60 * 60 * 1000));
    return {
      returnNoteId: (n._id as Types.ObjectId).toString(),
      poId: n.poId.toString(),
      cases: n.cases,
      daysOld,
      overdue: daysOld > RETURN_NOTE_WINDOW_DAYS,
    };
  });
}
