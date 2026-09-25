import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { Listing } from '../../../models/Listing.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Product } from '../../../models/Product.js';
import { Manufacturer } from '../../../models/Manufacturer.js';
import { Sku } from '../../../models/Sku.js';
import { SellerArea } from '../../../models/SellerArea.js';
import { Seller } from '../../../models/Seller.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { SellerReference } from '../../../models/SellerReference.js';
import { SellerDebit } from '../../../models/SellerDebit.js';
import { SellerCatalogueEntry } from '../../../models/SellerCatalogueEntry.js';
import { Tehsil } from '../../../models/Tehsil.js';
import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { Movement } from '../../../models/Movement.js';
import { Po } from '../../../models/Po.js';
import { PoLine } from '../../../models/PoLine.js';
import { SoLine } from '../../../models/SoLine.js';
import { So } from '../../../models/So.js';
import { Inspection } from '../../../models/Inspection.js';
import { ReturnNote } from '../../../models/ReturnNote.js';
import { PromotionOffer } from '../../../models/PromotionOffer.js';
import { Complaint } from '../../../models/Complaint.js';
import {
  NonOrderReason,
  SUPPLY_GAP_CODES,
  type SupplyGapCode,
} from '../../../models/NonOrderReason.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { addDays } from '../../../shared/clock.js';
import { FUNNEL_WINDOW_DAYS } from './purchase.funnel.js';
import { getSellerScorecard, type SellerScorecardDto } from '../../conduct/conduct.service.js';

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
// Per-ask seller states, in the prototype's own vocabulary — "Quoted" /
// "Listed, silent" / "Carries it, not listed" — distinct from `sellerCounts`
// above (`quoted/active/dormant/dark`, BR-272's own states, kept as-is: they
// answer a different question, "has this seller ever engaged this SKU",
// while this answers "what would I find in his file right now"). Seller net
// rate is shown deliberately — BR-069's "no rupee figure" wall is about
// buyer-facing/aggregate Purchase surfaces (the demand list, the funnel);
// a seller's own quoted or listed rate is routine Purchase business, already
// shown on the seller file and the confirmations queue.
// ---------------------------------------------------------------------------

export interface AskSellerStateItem {
  sellerId: string;
  firm: string;
  state: 'quoted' | 'listed' | 'carries';
  ratePaise: number | null;
  gapCodes: string[];
}

export async function getAskSellerStates(askId: string): Promise<AskSellerStateItem[]> {
  const ask = await Ask.findById(askId);
  if (!ask) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
  const skuIds = await skuIdsForAsk(ask);
  let productId = ask.productId ? (ask.productId as Types.ObjectId).toString() : null;
  if (!productId && skuIds.length) {
    const sku = await Sku.findById(skuIds[0]);
    productId = sku ? (sku.productId as Types.ObjectId).toString() : null;
  }

  const quotes = await Quote.find({ askId: ask._id, status: 'live' });
  const quoteBySellerId = new Map(
    quotes.map((q) => [(q.sellerId as Types.ObjectId).toString(), q]),
  );

  const listingLines = skuIds.length ? await ListingLine.find({ skuId: { $in: skuIds } }) : [];
  const liveListings = listingLines.length
    ? await Listing.find({ _id: { $in: listingLines.map((l) => l.listingId) }, state: 'live' })
    : [];
  const listingById = new Map(liveListings.map((l) => [(l._id as Types.ObjectId).toString(), l]));
  const rateBySellerId = new Map<string, number>();
  for (const line of listingLines) {
    const listing = listingById.get((line.listingId as Types.ObjectId).toString());
    if (!listing) continue;
    rateBySellerId.set((listing.sellerId as Types.ObjectId).toString(), line.ratePaise);
  }

  const catalogueEntries = productId ? await SellerCatalogueEntry.find({ productId }) : [];
  const carryingSellerIds = new Set(
    catalogueEntries.map((e) => (e.sellerId as Types.ObjectId).toString()),
  );

  const allSellerIds = new Set([
    ...quoteBySellerId.keys(),
    ...rateBySellerId.keys(),
    ...carryingSellerIds,
  ]);
  if (allSellerIds.size === 0) return [];

  const sellers = await Seller.find({ _id: { $in: [...allSellerIds] } });
  const counterparties = await Counterparty.find({
    _id: { $in: sellers.map((s) => s.counterpartyId) },
  });
  const firmByCounterpartyId = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '—']),
  );

  const order = { quoted: 0, listed: 1, carries: 2 };
  return sellers
    .map((s) => {
      const sellerId = (s._id as Types.ObjectId).toString();
      const quote = quoteBySellerId.get(sellerId);
      const state: AskSellerStateItem['state'] = quote
        ? 'quoted'
        : rateBySellerId.has(sellerId)
          ? 'listed'
          : 'carries';
      return {
        sellerId,
        firm: firmByCounterpartyId.get((s.counterpartyId as Types.ObjectId).toString()) ?? '—',
        state,
        ratePaise: quote ? quote.ratePaiseForIndore : (rateBySellerId.get(sellerId) ?? null),
        gapCodes: quote?.gapCodes ?? [],
      };
    })
    .sort((a, b) => order[a.state] - order[b.state]);
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
// Seller recovery — BR-206's other half of a Controller-decided dispute:
// "Purchase owns any recovery from the seller... neither sees the other's
// number." This reads only complaints Controller has already decided
// `seller_fault`; it carries the seller and the debit note, never the buyer,
// never the buyer's note, and never the disposition text Sales shows the
// buyer (`desk/sales`'s `getComplaintQueue` is that side).
// ---------------------------------------------------------------------------

export interface SellerRecoveryItem {
  complaintId: string;
  sellerId: string;
  debitNoteId: string | null;
  decidedAt: string | null;
}

export async function getSellerRecoveryQueue(): Promise<SellerRecoveryItem[]> {
  const complaints = await Complaint.find({ disposition: 'seller_fault' }).sort({ decidedAt: -1 });
  const soIds = complaints.map((c) => c.soId);
  const sos = await So.find({ _id: { $in: soIds } });
  const soIdToSellerId = new Map(
    sos.map((so) => [
      (so._id as Types.ObjectId).toString(),
      (so.sellerId as Types.ObjectId).toString(),
    ]),
  );
  return complaints.map((c) => ({
    complaintId: (c._id as Types.ObjectId).toString(),
    sellerId: soIdToSellerId.get(c.soId.toString()) ?? '',
    debitNoteId: c.debitNoteId ? c.debitNoteId.toString() : null,
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
  }));
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

// ---------------------------------------------------------------------------
// Purchase-desk v2 — the seller catalogue. What a seller CAN supply, from a
// phone call: no rate, no condition set, no territory, never on the buyer
// board on its own. Kept as its own collection (`SellerCatalogueEntry`),
// deliberately separate from `Listing`/`ListingLine` (a priced offer) — see
// `models/SellerCatalogueEntry.ts`.
// ---------------------------------------------------------------------------

export interface SellerCatalogueEntryInput {
  sellerId: string;
  productId: string;
  skuIds?: string[];
}

/** Add-if-missing, update-in-place otherwise — one call handles the desk's
 * whole "what does he carry" form, product level or pack level. */
export async function upsertSellerCatalogueEntry(
  input: SellerCatalogueEntryInput,
  actor: { employeeId: string },
): Promise<{ entryId: string }> {
  const seller = await Seller.findById(input.sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const product = await Product.findById(input.productId);
  if (!product) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });

  const entry = await SellerCatalogueEntry.findOneAndUpdate(
    { sellerId: input.sellerId, productId: input.productId },
    { $set: { skuIds: input.skuIds ?? [], setBy: actor.employeeId, setAt: new Date() } },
    { upsert: true, new: true },
  );
  return { entryId: (entry!._id as Types.ObjectId).toString() };
}

export interface SellerCataloguePackItem {
  skuId: string;
  packLabel: string;
  skuState: string;
  listed: boolean;
  listingRatePaise: number | null;
}

export interface SellerCatalogueItem {
  entryId: string;
  productId: string;
  brand: string;
  technical: string;
  manufacturerName: string;
  productState: string;
  packsDetailed: boolean;
  packs: SellerCataloguePackItem[];
  setAt: string;
  setBy: string;
}

/** What a seller sells, per the seller-file screen and `EnterListingPage`'s pack picker. */
export async function getSellerCatalogue(sellerId: string): Promise<SellerCatalogueItem[]> {
  const entries = await SellerCatalogueEntry.find({ sellerId }).sort({ setAt: -1 });
  const productIds = entries.map((e) => e.productId);
  const products = await Product.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  const manufacturers = await Manufacturer.find({
    _id: { $in: products.map((p) => p.manufacturerId) },
  });
  const manufacturerById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m]),
  );
  const allSkus = await Sku.find({ productId: { $in: productIds } });
  const skusByProduct = new Map<string, (typeof allSkus)[number][]>();
  for (const sku of allSkus) {
    const key = (sku.productId as Types.ObjectId).toString();
    if (!skusByProduct.has(key)) skusByProduct.set(key, []);
    skusByProduct.get(key)!.push(sku);
  }
  const sellerListings = await Listing.find({ sellerId, state: 'live' });
  const listingLines = await ListingLine.find({
    listingId: { $in: sellerListings.map((l) => l._id) },
  });
  const rateBySkuId = new Map(
    listingLines.map((l) => [(l.skuId as Types.ObjectId).toString(), l.ratePaise]),
  );

  return entries.map((entry) => {
    const productKey = (entry.productId as Types.ObjectId).toString();
    const product = productById.get(productKey);
    const manufacturer = product
      ? manufacturerById.get((product.manufacturerId as unknown as Types.ObjectId).toString())
      : undefined;
    const productSkus = skusByProduct.get(productKey) ?? [];
    const relevantSkus = entry.skuIds.length
      ? productSkus.filter((s) =>
          entry.skuIds.some((id) => (id as Types.ObjectId).equals(s._id as Types.ObjectId)),
        )
      : productSkus;
    return {
      entryId: (entry._id as Types.ObjectId).toString(),
      productId: productKey,
      brand: product?.brand ?? '—',
      technical: product?.technical ?? '—',
      manufacturerName: manufacturer?.name ?? '—',
      productState: product?.state ?? 'live',
      packsDetailed: entry.skuIds.length > 0,
      packs: relevantSkus.map((s) => {
        const skuKey = (s._id as Types.ObjectId).toString();
        return {
          skuId: skuKey,
          packLabel: s.packLabel,
          skuState: s.state,
          listed: rateBySkuId.has(skuKey),
          listingRatePaise: rateBySkuId.get(skuKey) ?? null,
        };
      }),
      setAt: entry.setAt.toISOString(),
      setBy: entry.setBy.toString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Supply matrix — the two directions of one dataset: catalogue + live
// listings, read either by product (the call list) or by seller (his whole
// business).
// ---------------------------------------------------------------------------

export interface SupplyMatrixProductRow {
  productId: string;
  brand: string;
  technical: string;
  manufacturerName: string;
  productState: string;
  carryCount: number;
  listedCount: number;
}

export async function getSupplyMatrixByProduct(): Promise<SupplyMatrixProductRow[]> {
  const products = await Product.find({ active: true });
  const manufacturers = await Manufacturer.find({});
  const manufacturerById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m]),
  );
  const entries = await SellerCatalogueEntry.find({});
  const carrySellersByProduct = new Map<string, Set<string>>();
  for (const e of entries) {
    const key = (e.productId as Types.ObjectId).toString();
    if (!carrySellersByProduct.has(key)) carrySellersByProduct.set(key, new Set());
    carrySellersByProduct.get(key)!.add((e.sellerId as Types.ObjectId).toString());
  }

  const skus = await Sku.find({ productId: { $in: products.map((p) => p._id) } });
  const skuToProduct = new Map(
    skus.map((s) => [
      (s._id as Types.ObjectId).toString(),
      (s.productId as Types.ObjectId).toString(),
    ]),
  );
  const listingLines = await ListingLine.find({ skuId: { $in: skus.map((s) => s._id) } });
  const liveListings = await Listing.find({
    _id: { $in: listingLines.map((l) => l.listingId) },
    state: 'live',
  });
  const sellerByListingId = new Map(
    liveListings.map((l) => [
      (l._id as Types.ObjectId).toString(),
      (l.sellerId as Types.ObjectId).toString(),
    ]),
  );
  const listedSellersByProduct = new Map<string, Set<string>>();
  for (const line of listingLines) {
    const sellerId = sellerByListingId.get((line.listingId as Types.ObjectId).toString());
    if (!sellerId) continue;
    const productKey = skuToProduct.get((line.skuId as Types.ObjectId).toString());
    if (!productKey) continue;
    if (!listedSellersByProduct.has(productKey)) listedSellersByProduct.set(productKey, new Set());
    listedSellersByProduct.get(productKey)!.add(sellerId);
  }

  return products.map((p) => {
    const key = (p._id as Types.ObjectId).toString();
    const manufacturer = manufacturerById.get(
      (p.manufacturerId as unknown as Types.ObjectId).toString(),
    );
    return {
      productId: key,
      brand: p.brand,
      technical: p.technical,
      manufacturerName: manufacturer?.name ?? '—',
      productState: p.state,
      carryCount: carrySellersByProduct.get(key)?.size ?? 0,
      listedCount: listedSellersByProduct.get(key)?.size ?? 0,
    };
  });
}

export interface SupplyMatrixSellerRow {
  sellerId: string;
  firm: string;
  trustTier: string;
  carryCount: number;
  listedCount: number;
  manufacturerNames: string[];
}

export async function getSupplyMatrixBySeller(): Promise<SupplyMatrixSellerRow[]> {
  const sellers = await Seller.find({});
  const counterparties = await Counterparty.find({
    _id: { $in: sellers.map((s) => s.counterpartyId) },
  });
  const counterpartyById = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c]),
  );
  const entries = await SellerCatalogueEntry.find({});
  const products = await Product.find({ _id: { $in: entries.map((e) => e.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  const manufacturers = await Manufacturer.find({
    _id: { $in: products.map((p) => p.manufacturerId) },
  });
  const manufacturerById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m]),
  );
  const entriesBySeller = new Map<string, (typeof entries)[number][]>();
  for (const e of entries) {
    const key = (e.sellerId as Types.ObjectId).toString();
    if (!entriesBySeller.has(key)) entriesBySeller.set(key, []);
    entriesBySeller.get(key)!.push(e);
  }
  const liveListings = await Listing.find({ state: 'live' });

  return sellers.map((s) => {
    const key = (s._id as Types.ObjectId).toString();
    const myEntries = entriesBySeller.get(key) ?? [];
    const myListedProductIds = new Set(
      liveListings
        .filter((l) => (l.sellerId as Types.ObjectId).toString() === key)
        .map((l) => (l.productId as Types.ObjectId).toString()),
    );
    const manufacturerNames = [
      ...new Set(
        myEntries.map((e) => {
          const product = productById.get((e.productId as Types.ObjectId).toString());
          const manufacturer = product
            ? manufacturerById.get((product.manufacturerId as unknown as Types.ObjectId).toString())
            : undefined;
          return manufacturer?.name ?? '—';
        }),
      ),
    ];
    return {
      sellerId: key,
      firm: counterpartyById.get((s.counterpartyId as Types.ObjectId).toString())?.firm ?? '—',
      trustTier: s.trustTier,
      carryCount: myEntries.length,
      listedCount: myEntries.filter((e) =>
        myListedProductIds.has((e.productId as Types.ObjectId).toString()),
      ).length,
      manufacturerNames,
    };
  });
}

// ---------------------------------------------------------------------------
// Confirmations — piles waiting on a seller's decision. `Pile.confirmWindowEndsAt`
// (BR-135) already carries the chase clock; nothing new to model.
// ---------------------------------------------------------------------------

export interface PileAwaitingDecisionItem {
  pileId: string;
  sellerId: string;
  sellerCounterpartyId: string;
  skuId: string;
  ratePaise: number;
  boxes: number;
  buyers: number;
  openedAt: string;
  confirmWindowEndsAt: string;
  chaseLeftHours: number;
}

export async function getPilesAwaitingDecision(): Promise<PileAwaitingDecisionItem[]> {
  const piles = await Pile.find({ decision: null }).sort({ openedAt: 1 });
  const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
  const lineById = new Map(lines.map((l) => [(l._id as Types.ObjectId).toString(), l]));
  const listings = await Listing.find({ _id: { $in: lines.map((l) => l.listingId) } });
  const listingById = new Map(listings.map((l) => [(l._id as Types.ObjectId).toString(), l]));
  const sellers = await Seller.find({ _id: { $in: listings.map((l) => l.sellerId) } });
  const sellerById = new Map(sellers.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const requests = await PileRequest.find({ pileId: { $in: piles.map((p) => p._id) } });
  const now = Date.now();

  return piles.map((pile) => {
    const line = lineById.get((pile.listingLineId as Types.ObjectId).toString());
    const listing = line
      ? listingById.get((line.listingId as Types.ObjectId).toString())
      : undefined;
    const sellerId = listing ? (listing.sellerId as Types.ObjectId).toString() : '';
    const seller = sellerById.get(sellerId);
    const myRequests = requests.filter((r) =>
      (r.pileId as Types.ObjectId).equals(pile._id as Types.ObjectId),
    );
    return {
      pileId: (pile._id as Types.ObjectId).toString(),
      sellerId,
      sellerCounterpartyId: seller ? (seller.counterpartyId as Types.ObjectId).toString() : '',
      skuId: line ? (line.skuId as Types.ObjectId).toString() : '',
      ratePaise: line?.ratePaise ?? 0,
      boxes: myRequests.reduce((sum, r) => sum + r.qty, 0),
      buyers: new Set(myRequests.map((r) => (r.buyerId as Types.ObjectId).toString())).size,
      openedAt: pile.openedAt.toISOString(),
      confirmWindowEndsAt: pile.confirmWindowEndsAt.toISOString(),
      chaseLeftHours:
        Math.round(((pile.confirmWindowEndsAt.getTime() - now) / (60 * 60 * 1000)) * 10) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// Dispatch chase — Purchase's own pre-leg-1 queue, built entirely from
// fields `chain.service.ts` already maintains (`dispatchDueDate`,
// `sameDayMissAt`, `noDispatch48hAt`) plus `Movement` for the in-transit
// bucket. The bulk dispatch-clock lifeline stays a Controller action
// (`modules/controller`'s `grantBulkLifeline`) — this queue only chases.
// ---------------------------------------------------------------------------

export interface DispatchQueueItem {
  poId: string;
  poNo: string;
  sellerId: string;
  bucket: 'due' | 'overdue' | 'in_transit';
  dispatchDueDate: string;
  hoursLeft: number | null;
  sameDayMiss: boolean;
  noDispatch48h: boolean;
  dispatchedAt: string | null;
  daysInTransit: number | null;
}

export async function getDispatchChaseQueue(): Promise<DispatchQueueItem[]> {
  const now = Date.now();
  const [pending, dispatchedLeg1] = await Promise.all([
    Po.find({ state: 'released', failed: false }),
    Po.find({ state: 'dispatched_leg1', failed: false, receivedAt: null }),
  ]);
  const movements = await Movement.find({
    chainId: { $in: dispatchedLeg1.map((p) => p.chainId) },
    leg: 1,
  });
  const movementByChain = new Map(
    movements.map((m) => [(m.chainId as Types.ObjectId).toString(), m]),
  );

  const dueOrOverdue: DispatchQueueItem[] = pending.map((po) => {
    const hoursLeft = (po.dispatchDueDate.getTime() - now) / (60 * 60 * 1000);
    return {
      poId: (po._id as Types.ObjectId).toString(),
      poNo: po.poNo,
      sellerId: (po.sellerId as Types.ObjectId).toString(),
      bucket: hoursLeft < 0 ? 'overdue' : 'due',
      dispatchDueDate: po.dispatchDueDate.toISOString(),
      hoursLeft: Math.round(hoursLeft * 10) / 10,
      sameDayMiss: !!po.sameDayMissAt,
      noDispatch48h: !!po.noDispatch48hAt,
      dispatchedAt: null,
      daysInTransit: null,
    };
  });

  const inTransit: DispatchQueueItem[] = dispatchedLeg1.map((po) => {
    const movement = movementByChain.get((po.chainId as Types.ObjectId).toString());
    const dispatchedAt = movement?.dispatchedAt ?? null;
    return {
      poId: (po._id as Types.ObjectId).toString(),
      poNo: po.poNo,
      sellerId: (po.sellerId as Types.ObjectId).toString(),
      bucket: 'in_transit',
      dispatchDueDate: po.dispatchDueDate.toISOString(),
      hoursLeft: null,
      sameDayMiss: !!po.sameDayMissAt,
      noDispatch48h: !!po.noDispatch48hAt,
      dispatchedAt: dispatchedAt ? dispatchedAt.toISOString() : null,
      daysInTransit: dispatchedAt
        ? Math.floor((now - dispatchedAt.getTime()) / (24 * 60 * 60 * 1000))
        : null,
    };
  });

  return [...dueOrOverdue, ...inTransit].sort((a, b) => (a.hoursLeft ?? 0) - (b.hoursLeft ?? 0));
}

/** A logged chase, not a state change — the dispatch clock itself is untouched. */
export async function logDispatchChase(
  poId: string,
  actor: { employeeId: string; correlationId: string },
): Promise<void> {
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'po',
    entityId: po._id as Types.ObjectId,
    field: 'dispatch_chase_logged',
    correlationId: actor.correlationId,
  });
}

// ---------------------------------------------------------------------------
// Recovery — dock findings still waiting on Purchase's own act (BR-190: "the
// dock records, Purchase applies"). `Po.inspected` flips true only once
// `dock.service.ts#applyInspection` has actually run (`transitionToInspected`);
// a whole-lot rejection instead sets `Po.failed` — either way, "pending" is
// simply neither yet being true on the PO an `Inspection` already exists for.
// ---------------------------------------------------------------------------

export interface InspectionPendingApplyItem {
  inspectionId: string;
  poId: string;
  poNo: string;
  sellerId: string;
  casesAccepted: number;
  casesRejected: number;
  reasons: string[];
  signedAt: string;
  wholeLot: boolean;
}

export async function getInspectionsPendingApply(): Promise<InspectionPendingApplyItem[]> {
  const inspections = await Inspection.find({}).sort({ signedAt: 1 });
  const pos = await Po.find({
    _id: { $in: inspections.map((i) => i.poId) },
    inspected: false,
    failed: false,
  });
  const poById = new Map(pos.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  return inspections
    .filter((i) => poById.has(i.poId.toString()))
    .map((i) => {
      const po = poById.get(i.poId.toString())!;
      return {
        inspectionId: (i._id as Types.ObjectId).toString(),
        poId: (po._id as Types.ObjectId).toString(),
        poNo: po.poNo,
        sellerId: (po.sellerId as Types.ObjectId).toString(),
        casesAccepted: i.casesAccepted,
        casesRejected: i.casesRejected,
        reasons: i.reasons,
        signedAt: i.signedAt.toISOString(),
        wholeLot: i.casesAccepted === 0,
      };
    });
}

// ---------------------------------------------------------------------------
// Seller file — open demand he could serve: asks on a product/SKU already in
// his catalogue, that he has not yet quoted. Not a new signal — the same
// join `getAskSellerStates` does, run the other direction (one seller,
// every matching ask, instead of one ask, every matching seller).
// ---------------------------------------------------------------------------

export interface SellerOpenDemandItem {
  askId: string;
  skuId: string | null;
  productId: string | null;
  qty: number;
  ageHours: number;
  hasQuoted: boolean;
}

export async function getOpenDemandForSeller(sellerId: string): Promise<SellerOpenDemandItem[]> {
  const entries = await SellerCatalogueEntry.find({ sellerId });
  if (entries.length === 0) return [];
  const productIds = entries.map((e) => e.productId);
  const skus = await Sku.find({ productId: { $in: productIds } });
  const skuIds = skus.map((s) => s._id);

  const asks = await Ask.find({
    state: { $in: ['open', 'quoted'] },
    $or: [{ productId: { $in: productIds } }, { skuId: { $in: skuIds } }],
  }).sort({ createdAt: 1 });

  const quotes = await Quote.find({ askId: { $in: asks.map((a) => a._id) }, sellerId });
  const quotedAskIds = new Set(quotes.map((q) => q.askId.toString()));

  const now = Date.now();
  return asks.map((a) => ({
    askId: (a._id as Types.ObjectId).toString(),
    skuId: a.skuId ? (a.skuId as Types.ObjectId).toString() : null,
    productId: a.productId ? (a.productId as Types.ObjectId).toString() : null,
    qty: a.qty,
    ageHours:
      Math.round(
        ((now - (a as unknown as { createdAt: Date }).createdAt.getTime()) / (60 * 60 * 1000)) * 10,
      ) / 10,
    hasQuoted: quotedAskIds.has((a._id as Types.ObjectId).toString()),
  }));
}

// ---------------------------------------------------------------------------
// The seller file — one aggregate read combining every existing seller-side
// signal this codebase already keeps (area, references, conduct ladder,
// debits, open return notes) plus the two new ones above (catalogue, and
// his live listings with their desk-authorship trail, if any).
// ---------------------------------------------------------------------------

export interface SellerFileListingItem {
  listingId: string;
  lineId: string;
  skuId: string;
  packLabel: string;
  ratePaise: number;
  scopeType: string;
  createdAt: string;
  deskEntered: boolean;
  enteredBy: string | null;
  callNote: string | null;
}

export interface SellerFileDto {
  sellerId: string;
  counterpartyId: string;
  firm: string;
  gstin: string;
  ownerName: string;
  mobile: string;
  licenceNo: string;
  trustTier: string;
  dispatchCutoffTime: string;
  suppliesCompleted: number;
  since: string;
  area: Array<{ tehsilId: string; name: string; district: string }>;
  references: Array<{ firm: string; phone: string; whatTheySaid: string }>;
  scorecard: SellerScorecardDto;
  openDebits: Array<{ debitId: string; reason: string; amountPaise: number; netted: boolean }>;
  openReturnNotes: Array<{
    returnNoteId: string;
    poId: string;
    cases: number;
    daysOld: number;
    overdue: boolean;
  }>;
  catalogue: SellerCatalogueItem[];
  listings: SellerFileListingItem[];
  openDemand: SellerOpenDemandItem[];
}

export async function getSellerFile(sellerId: string): Promise<SellerFileDto> {
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const counterparty = await Counterparty.findById(seller.counterpartyId);
  if (!counterparty)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Counterparty not found.' });

  const [areas, references, debits, returnNotes, catalogue, listings, scorecard, openDemand] =
    await Promise.all([
      SellerArea.find({ sellerId: seller._id }),
      SellerReference.find({ sellerId: seller._id }),
      SellerDebit.find({ counterpartyId: seller._id, nettedAgainst: null }),
      ReturnNote.find({ sellerId: seller._id, returnedAt: null }),
      getSellerCatalogue(sellerId),
      Listing.find({ sellerId: seller._id, state: 'live' }),
      getSellerScorecard((seller.counterpartyId as Types.ObjectId).toString()),
      getOpenDemandForSeller(sellerId),
    ]);

  const tehsils = await Tehsil.find({ _id: { $in: areas.map((a) => a.tehsilId) } });
  const tehsilById = new Map(tehsils.map((t) => [(t._id as Types.ObjectId).toString(), t]));

  const lines = await ListingLine.find({ listingId: { $in: listings.map((l) => l._id) } });
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const listingById = new Map(listings.map((l) => [(l._id as Types.ObjectId).toString(), l]));

  const now = Date.now();
  const listingDtos: SellerFileListingItem[] = lines.map((line) => {
    const listing = listingById.get((line.listingId as Types.ObjectId).toString());
    const sku = skuById.get((line.skuId as Types.ObjectId).toString());
    const lastProxy = line.proxyLog.length ? line.proxyLog[line.proxyLog.length - 1] : null;
    return {
      listingId: listing ? (listing._id as Types.ObjectId).toString() : '',
      lineId: (line._id as Types.ObjectId).toString(),
      skuId: (line.skuId as Types.ObjectId).toString(),
      packLabel: sku?.packLabel ?? '—',
      ratePaise: line.ratePaise,
      scopeType: listing?.scopeType ?? '',
      createdAt: (line as unknown as { createdAt: Date }).createdAt.toISOString(),
      deskEntered: line.proxyLog.length > 0,
      enteredBy: lastProxy ? lastProxy.actingStaffId.toString() : null,
      callNote: lastProxy ? lastProxy.callNote : null,
    };
  });

  return {
    sellerId,
    counterpartyId: (seller.counterpartyId as Types.ObjectId).toString(),
    firm: counterparty.firm ?? '—',
    gstin: counterparty.gstin ?? '—',
    ownerName: counterparty.ownerName ?? '—',
    mobile: counterparty.mobile,
    licenceNo: counterparty.licenceNo ?? '—',
    trustTier: seller.trustTier,
    dispatchCutoffTime: seller.dispatchCutoffTime,
    suppliesCompleted: seller.suppliesCompleted,
    since: (seller as unknown as { createdAt: Date }).createdAt.toISOString(),
    area: areas.map((a) => {
      const tehsil = tehsilById.get((a.tehsilId as Types.ObjectId).toString());
      return {
        tehsilId: (a.tehsilId as Types.ObjectId).toString(),
        name: tehsil?.name ?? '—',
        district: tehsil?.district ?? '—',
      };
    }),
    references: references.map((r) => ({
      firm: r.firm,
      phone: r.phone,
      whatTheySaid: r.whatTheySaid,
    })),
    scorecard,
    openDebits: debits.map((d) => ({
      debitId: (d._id as Types.ObjectId).toString(),
      reason: d.reason,
      amountPaise: d.amountPaise,
      netted: !!d.nettedAgainst,
    })),
    openReturnNotes: returnNotes.map((r) => {
      const daysOld = Math.floor((now - r.raisedAt.getTime()) / (24 * 60 * 60 * 1000));
      return {
        returnNoteId: (r._id as Types.ObjectId).toString(),
        poId: r.poId.toString(),
        cases: r.cases,
        daysOld,
        overdue: daysOld > RETURN_NOTE_WINDOW_DAYS,
      };
    }),
    catalogue,
    listings: listingDtos,
    openDemand: openDemand.filter((d) => !d.hasQuoted),
  };
}

// ---------------------------------------------------------------------------
// Products → Analysis, all rows in one call — the existing per-product
// `getProductAnalysis` above, looped. Fine at this catalogue's scale (CH
// §19.8's own "kept deliberately small" — a few hundred products at most);
// revisit if that ever stops being true.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recovery — open seller debits, the Recovery screen's third section
// (BR-022, `SellerDebit` already models this; nothing new to store).
// ---------------------------------------------------------------------------

export interface OpenSellerDebitItem {
  debitId: string;
  sellerId: string;
  reason: string;
  amountPaise: number;
  raisedAt: string;
}

export async function getOpenSellerDebits(): Promise<OpenSellerDebitItem[]> {
  const debits = await SellerDebit.find({ nettedAgainst: null }).sort({ createdAt: -1 });
  return debits.map((d) => ({
    debitId: (d._id as Types.ObjectId).toString(),
    sellerId: d.counterpartyId.toString(),
    reason: d.reason,
    amountPaise: d.amountPaise,
    raisedAt: (d as unknown as { createdAt: Date }).createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Products → Analysis, the prototype's own shape — inquiries → quoted →
// ordered → fill%, plus current open interest and how many sellers carry it.
// Deliberately distinct from `getProductAnalysis` above (`CH §18.8`'s
// position-split/rejection-split identities, a different pre-existing
// measure this session found already built and left untouched). `inq`/
// `quoted`/`ordered` are windowed the same trailing 30 days the rest of the
// funnel (`purchase.funnel.ts`) uses; `open`/`sellers` are a live snapshot,
// not windowed — an ask's boxes stay "open" until it closes, however old.
// ---------------------------------------------------------------------------

export interface ProductFunnelRow {
  productId: string;
  inq: number;
  quoted: number;
  ordered: number;
  fillPct: number | null;
  openBoxes: number;
  sellerCount: number;
}

export async function getProductFunnel(
  productId: string,
  now: Date = new Date(),
): Promise<ProductFunnelRow> {
  const from = addDays(now, -FUNNEL_WINDOW_DAYS);
  const skus = await Sku.find({ productId });
  const skuIds = skus.map((s) => s._id as Types.ObjectId);

  const [windowAsks, openAsks, sellerCount] = await Promise.all([
    Ask.find({
      createdAt: { $gte: from },
      $or: [{ productId }, { skuId: { $in: skuIds } }],
    }),
    Ask.find({
      state: { $in: ['open', 'quoted'] },
      $or: [{ productId }, { skuId: { $in: skuIds } }],
    }),
    SellerCatalogueEntry.countDocuments({ productId }),
  ]);

  const quotedAskIds = new Set(
    (await Quote.find({ askId: { $in: windowAsks.map((a) => a._id) } })).map((q) =>
      q.askId.toString(),
    ),
  );
  const quoted = windowAsks.filter((a) =>
    quotedAskIds.has((a._id as Types.ObjectId).toString()),
  ).length;
  const ordered = windowAsks.filter((a) => a.state === 'converted').length;
  const openBoxes = openAsks.reduce((sum, a) => sum + a.qty, 0);

  return {
    productId,
    inq: windowAsks.length,
    quoted,
    ordered,
    fillPct: windowAsks.length ? Math.round((ordered / windowAsks.length) * 1000) / 10 : null,
    openBoxes,
    sellerCount,
  };
}

export async function getProductFunnelAll(): Promise<ProductFunnelRow[]> {
  const products = await Product.find({ active: true }).sort({ brand: 1 });
  const now = new Date();
  const rows: ProductFunnelRow[] = [];
  for (const product of products) {
    rows.push(await getProductFunnel((product._id as Types.ObjectId).toString(), now));
  }
  return rows;
}

export async function getProductAnalysisAll(): Promise<ProductAnalysis[]> {
  const products = await Product.find({ active: true }).sort({ brand: 1 });
  const results: ProductAnalysis[] = [];
  for (const product of products) {
    results.push(await getProductAnalysis((product._id as Types.ObjectId).toString()));
  }
  return results;
}
