import { Ask } from '../../../models/Ask.js';
import { OPEN_QUOTE_STATUSES, Quote } from '../../../models/Quote.js';
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
import { SellerDealership } from '../../../models/SellerDealership.js';
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
import { NonOrderReason, SUPPLY_GAP_CODES, } from '../../../models/NonOrderReason.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { addDays } from '../../../shared/clock.js';
import { FUNNEL_WINDOW_DAYS, getSellerFunnelMetrics, } from './purchase.funnel.js';
import { getSellerScorecard } from '../../conduct/conduct.service.js';
import { getSellerDealerships, resolveCatalogueEntries, } from './purchase.catalogue.js';
const RETURN_NOTE_WINDOW_DAYS = 30; // BR-189.
/**
 * Purchase is a supplier-side desk — a seller's firm name is exactly the
 * identity it is meant to see (unlike a buyer's, BR-067). Every queue on
 * this desk that used to show a raw `sellerId` hash now joins through this
 * instead, so a seller is always readable, never a hex string.
 */
async function getFirmBySellerId(sellerIds) {
    if (sellerIds.length === 0)
        return new Map();
    const sellers = await Seller.find({ _id: { $in: sellerIds } });
    const counterparties = await Counterparty.find({
        _id: { $in: sellers.map((s) => s.counterpartyId) },
    });
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '—']));
    return new Map(sellers.map((s) => [
        s._id.toString(),
        firmByCounterpartyId.get(s.counterpartyId.toString()) ?? '—',
    ]));
}
async function skuIdsForAsk(ask) {
    if (ask.skuId)
        return [ask.skuId];
    if (ask.productId) {
        const skus = await Sku.find({ productId: ask.productId });
        return skus.map((s) => s._id);
    }
    return [];
}
export async function getActiveDemandList(filters) {
    const asks = await Ask.find({ state: { $in: ['open', 'quoted'] } }).sort({ createdAt: -1 });
    const items = [];
    const productIdByAskId = new Map();
    for (const ask of asks) {
        const skuIds = await skuIdsForAsk(ask);
        let productId = ask.productId ? ask.productId.toString() : null;
        if (!productId && skuIds.length) {
            const sku = await Sku.findById(skuIds[0]);
            productId = sku ? sku.productId.toString() : null;
        }
        if (productId)
            productIdByAskId.set(ask._id.toString(), productId);
        const quotedSellerIds = new Set((await Quote.find({ askId: ask._id })).map((q) => q.sellerId.toString()));
        const listingLines = skuIds.length ? await ListingLine.find({ skuId: { $in: skuIds } }) : [];
        const liveListings = skuIds.length
            ? await Listing.find({ _id: { $in: listingLines.map((l) => l.listingId) }, state: 'live' })
            : [];
        const activeSellerIds = new Set(liveListings
            .map((l) => l.sellerId.toString())
            .filter((id) => !quotedSellerIds.has(id)));
        const soLines = skuIds.length ? await SoLine.find({ skuId: { $in: skuIds } }) : [];
        const sos = soLines.length ? await So.find({ _id: { $in: soLines.map((l) => l.soId) } }) : [];
        const everSuppliedSellerIds = new Set(sos
            .map((s) => s.sellerId.toString())
            .filter((id) => !quotedSellerIds.has(id) && !activeSellerIds.has(id)));
        const sellerCounts = {
            quoted: quotedSellerIds.size,
            active: activeSellerIds.size,
            dormant: everSuppliedSellerIds.size,
            dark: 0, // No principled way to count "never engaged, but in scope" without buyer tehsil — see file header.
        };
        const noSeller = sellerCounts.quoted + sellerCounts.active + sellerCounts.dormant === 0;
        if (filters.noSellerOnly && !noSeller)
            continue;
        items.push({
            askId: ask._id.toString(),
            qty: ask.qty,
            skuId: ask.skuId ? ask.skuId.toString() : null,
            productId: ask.productId ? ask.productId.toString() : null,
            createdAt: ask.createdAt.toISOString(),
            sellerCounts,
            noSeller,
        });
    }
    const products = productIdByAskId.size
        ? await Product.find({ _id: { $in: [...new Set(productIdByAskId.values())] } })
        : [];
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const manufacturers = products.length
        ? await Manufacturer.find({ _id: { $in: products.map((p) => p.manufacturerId) } })
        : [];
    const manufacturerById = new Map(manufacturers.map((m) => [m._id.toString(), m]));
    return items.map((item) => {
        const productId = productIdByAskId.get(item.askId);
        const product = productId ? productById.get(productId) : undefined;
        const manufacturer = product
            ? manufacturerById.get(product.manufacturerId.toString())
            : undefined;
        return {
            ...item,
            brand: product?.brand ?? '—',
            technical: product?.technical ?? '—',
            manufacturerName: manufacturer?.name ?? '—',
        };
    });
}
export async function getQuoteGapsForAsk(askId) {
    const quotes = await Quote.find({ askId, status: { $in: OPEN_QUOTE_STATUSES } }).sort({
        ratePaiseForIndore: 1,
    });
    return quotes.map((q) => ({
        quoteId: q._id.toString(),
        sellerId: q.sellerId.toString(),
        gapCodes: q.gapCodes ?? [],
    }));
}
export async function getAskSellerStates(askId) {
    const ask = await Ask.findById(askId);
    if (!ask)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
    const skuIds = await skuIdsForAsk(ask);
    let productId = ask.productId ? ask.productId.toString() : null;
    if (!productId && skuIds.length) {
        const sku = await Sku.findById(skuIds[0]);
        productId = sku ? sku.productId.toString() : null;
    }
    // A quote parked for Sales still counts as this seller having quoted — never raise it twice.
    const quotes = await Quote.find({ askId: ask._id, status: { $in: OPEN_QUOTE_STATUSES } });
    const quoteBySellerId = new Map(quotes.map((q) => [q.sellerId.toString(), q]));
    const listingLines = skuIds.length ? await ListingLine.find({ skuId: { $in: skuIds } }) : [];
    const liveListings = listingLines.length
        ? await Listing.find({ _id: { $in: listingLines.map((l) => l.listingId) }, state: 'live' })
        : [];
    const listingById = new Map(liveListings.map((l) => [l._id.toString(), l]));
    const rateBySellerId = new Map();
    for (const line of listingLines) {
        const listing = listingById.get(line.listingId.toString());
        if (!listing)
            continue;
        rateBySellerId.set(listing.sellerId.toString(), line.ratePaise);
    }
    const catalogueEntries = productId ? await resolveCatalogueEntries({ productId }) : [];
    const carryingSellerIds = new Set(catalogueEntries.map((e) => e.sellerId.toString()));
    const allSellerIds = new Set([
        ...quoteBySellerId.keys(),
        ...rateBySellerId.keys(),
        ...carryingSellerIds,
    ]);
    if (allSellerIds.size === 0)
        return [];
    const sellers = await Seller.find({ _id: { $in: [...allSellerIds] } });
    const counterparties = await Counterparty.find({
        _id: { $in: sellers.map((s) => s.counterpartyId) },
    });
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '—']));
    const order = { quoted: 0, listed: 1, carries: 2 };
    return sellers
        .map((s) => {
        const sellerId = s._id.toString();
        const quote = quoteBySellerId.get(sellerId);
        const state = quote
            ? 'quoted'
            : rateBySellerId.has(sellerId)
                ? 'listed'
                : 'carries';
        return {
            sellerId,
            sellerCounterpartyId: s.counterpartyId.toString(),
            firm: firmByCounterpartyId.get(s.counterpartyId.toString()) ?? '—',
            state,
            ratePaise: quote ? quote.ratePaiseForIndore : (rateBySellerId.get(sellerId) ?? null),
            gapCodes: quote?.gapCodes ?? [],
        };
    })
        .sort((a, b) => order[a.state] - order[b.state]);
}
/** Two sources per cell is BR-274's target; this returns the raw count, the desk reads the target against it. */
export async function getCoverageMap() {
    const areas = await SellerArea.find({});
    const products = await Product.find({ active: true });
    const skus = await Sku.find({ productId: { $in: products.map((p) => p._id) } });
    const listingLines = await ListingLine.find({ skuId: { $in: skus.map((s) => s._id) } });
    const liveListings = await Listing.find({
        _id: { $in: listingLines.map((l) => l.listingId) },
        state: 'live',
    });
    const skuToManufacturer = new Map(skus.map((s) => {
        const product = products.find((p) => p._id.equals(s.productId));
        return [s._id.toString(), product?.manufacturerId?.toString() ?? null];
    }));
    const lineToManufacturer = new Map(listingLines.map((l) => [
        l._id.toString(),
        skuToManufacturer.get(l.skuId.toString()) ?? null,
    ]));
    const sellerToManufacturers = new Map();
    for (const listing of liveListings) {
        const lines = listingLines.filter((l) => l.listingId.equals(listing._id));
        const sellerId = listing.sellerId.toString();
        for (const line of lines) {
            const manufacturerId = lineToManufacturer.get(line._id.toString());
            if (!manufacturerId)
                continue;
            if (!sellerToManufacturers.has(sellerId))
                sellerToManufacturers.set(sellerId, new Set());
            sellerToManufacturers.get(sellerId).add(manufacturerId);
        }
    }
    const cellCounts = new Map();
    for (const area of areas) {
        const sellerId = area.sellerId.toString();
        const manufacturerIds = sellerToManufacturers.get(sellerId);
        if (!manufacturerIds)
            continue;
        for (const manufacturerId of manufacturerIds) {
            const key = `${manufacturerId}::${area.tehsilId.toString()}`;
            cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
        }
    }
    return [...cellCounts.entries()].map(([key, sellerCount]) => {
        const [manufacturerId, tehsilId] = key.split('::');
        return { manufacturerId: manufacturerId, tehsilId: tehsilId, sellerCount };
    });
}
export async function getProductAnalysis(productId) {
    const skus = await Sku.find({ productId });
    const skuIds = skus.map((s) => s._id);
    const soLines = await SoLine.find({ skuId: { $in: skuIds } });
    const sos = await So.find({ _id: { $in: soLines.map((l) => l.soId) } });
    const soById = new Map(sos.map((s) => [s._id.toString(), s]));
    const positionSplit = {
        Distributor: 0,
        Dealer: 0,
        Retailer: 0,
        Trader: 0,
    };
    let totalBoxesOrdered = 0;
    for (const line of soLines) {
        const so = soById.get(line.soId.toString());
        if (!so)
            continue;
        positionSplit[so.tierAtOrder] += line.boxes;
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
export async function getProductSellers(productId) {
    const skus = await Sku.find({ productId });
    const packLabelBySkuId = new Map(skus.map((s) => [s._id.toString(), s.packLabel]));
    const lines = skus.length
        ? await ListingLine.find({ skuId: { $in: skus.map((s) => s._id) } })
        : [];
    const liveListings = lines.length
        ? await Listing.find({ _id: { $in: lines.map((l) => l.listingId) }, state: 'live' })
        : [];
    const listingById = new Map(liveListings.map((l) => [l._id.toString(), l]));
    const listingsBySeller = new Map();
    for (const line of lines) {
        const listing = listingById.get(line.listingId.toString());
        if (!listing)
            continue;
        const key = listing.sellerId.toString();
        const packs = listingsBySeller.get(key) ?? [];
        packs.push({
            packLabel: packLabelBySkuId.get(line.skuId.toString()) ?? '—',
            ratePaise: line.ratePaise,
            qty: line.qty,
            expiryBand: line.expiryBand,
            deliveryBand: line.deliveryBand,
            moqExact: line.moqExact,
        });
        listingsBySeller.set(key, packs);
    }
    const entries = await resolveCatalogueEntries({ productId });
    const sellerIds = new Set([
        ...listingsBySeller.keys(),
        ...entries.map((e) => e.sellerId.toString()),
    ]);
    if (sellerIds.size === 0)
        return [];
    const sellers = await Seller.find({ _id: { $in: [...sellerIds] } });
    const counterparties = await Counterparty.find({
        _id: { $in: sellers.map((s) => s.counterpartyId) },
    });
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '—']));
    return sellers
        .map((s) => {
        const sellerId = s._id.toString();
        const listings = (listingsBySeller.get(sellerId) ?? []).sort((a, b) => a.ratePaise - b.ratePaise);
        return {
            sellerId,
            firm: firmByCounterpartyId.get(s.counterpartyId.toString()) ?? '—',
            state: listings.length > 0 ? 'listed' : 'carries',
            listings,
        };
    })
        .sort((a, b) => a.state === b.state ? a.firm.localeCompare(b.firm) : a.state === 'listed' ? -1 : 1);
}
export async function getAbsorptionQueue() {
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
export async function recordSupplyGapReason(input, actor) {
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
    return { nonOrderReasonId: row._id.toString() };
}
export async function getSellerRecoveryQueue() {
    const complaints = await Complaint.find({ disposition: 'seller_fault' }).sort({ decidedAt: -1 });
    const soIds = complaints.map((c) => c.soId);
    const sos = await So.find({ _id: { $in: soIds } });
    const soIdToSellerId = new Map(sos.map((so) => [
        so._id.toString(),
        so.sellerId.toString(),
    ]));
    const firmBySellerId = await getFirmBySellerId(sos.map((so) => so.sellerId));
    return complaints.map((c) => {
        const sellerId = soIdToSellerId.get(c.soId.toString()) ?? '';
        return {
            complaintId: c._id.toString(),
            sellerId,
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            debitNoteId: c.debitNoteId ? c.debitNoteId.toString() : null,
            decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
        };
    });
}
export async function getReturnNoteAgeing() {
    const notes = await ReturnNote.find({ returnedAt: null }).sort({ raisedAt: 1 });
    const now = Date.now();
    return notes.map((n) => {
        const daysOld = Math.floor((now - n.raisedAt.getTime()) / (24 * 60 * 60 * 1000));
        return {
            returnNoteId: n._id.toString(),
            poId: n.poId.toString(),
            cases: n.cases,
            daysOld,
            dueDate: n.dueBy.toISOString(),
            overdue: daysOld > RETURN_NOTE_WINDOW_DAYS,
        };
    });
}
export async function getOnBoardNotQuotedQueue() {
    const asks = await Ask.find({ state: { $in: ['open', 'quoted'] } }).sort({ createdAt: 1 });
    const rows = [];
    for (const ask of asks) {
        const states = await getAskSellerStates(ask._id.toString());
        const sellersListedNotQuoted = states.filter((s) => s.state === 'listed').length;
        if (sellersListedNotQuoted === 0)
            continue;
        const skuIds = await skuIdsForAsk(ask);
        let productId = ask.productId ? ask.productId.toString() : null;
        if (!productId && skuIds.length) {
            const sku = await Sku.findById(skuIds[0]);
            productId = sku ? sku.productId.toString() : null;
        }
        rows.push({
            askId: ask._id.toString(),
            productId,
            qty: ask.qty,
            sellersListedNotQuoted,
        });
    }
    const productIds = [...new Set(rows.map((r) => r.productId).filter((id) => !!id))];
    const products = productIds.length ? await Product.find({ _id: { $in: productIds } }) : [];
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    return rows.map((r) => ({
        ...r,
        brand: r.productId ? (productById.get(r.productId)?.brand ?? '—') : '—',
    }));
}
/** Add-if-missing, update-in-place otherwise — one call handles the desk's
 * whole "what does he carry" form, product level or pack level. */
export async function upsertSellerCatalogueEntry(input, actor) {
    const seller = await Seller.findById(input.sellerId);
    if (!seller)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
    const product = await Product.findById(input.productId);
    if (!product)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    const entry = await SellerCatalogueEntry.findOneAndUpdate({ sellerId: input.sellerId, productId: input.productId }, { $set: { skuIds: input.skuIds ?? [], setBy: actor.employeeId, setAt: new Date() } }, { upsert: true, new: true });
    return { entryId: entry._id.toString() };
}
/**
 * What a seller sells, per the seller-file screen and `EnterListingPage`'s
 * pack picker: his hand-entered products plus every product of the companies
 * he deals in (see `purchase.catalogue.ts`).
 */
export async function getSellerCatalogue(sellerId) {
    const entries = (await resolveCatalogueEntries({ sellerId })).sort((a, b) => b.setAt.getTime() - a.setAt.getTime());
    const productIds = entries.map((e) => e.productId);
    const products = await Product.find({ _id: { $in: productIds } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const manufacturers = await Manufacturer.find({
        _id: { $in: products.map((p) => p.manufacturerId) },
    });
    const manufacturerById = new Map(manufacturers.map((m) => [m._id.toString(), m]));
    const allSkus = await Sku.find({ productId: { $in: productIds } });
    const skusByProduct = new Map();
    for (const sku of allSkus) {
        const key = sku.productId.toString();
        if (!skusByProduct.has(key))
            skusByProduct.set(key, []);
        skusByProduct.get(key).push(sku);
    }
    const sellerListings = await Listing.find({ sellerId, state: 'live' });
    const listingLines = await ListingLine.find({
        listingId: { $in: sellerListings.map((l) => l._id) },
    });
    const rateBySkuId = new Map(listingLines.map((l) => [l.skuId.toString(), l.ratePaise]));
    return entries.map((entry) => {
        const productKey = entry.productId.toString();
        const product = productById.get(productKey);
        const manufacturer = product
            ? manufacturerById.get(product.manufacturerId.toString())
            : undefined;
        const productSkus = skusByProduct.get(productKey) ?? [];
        const relevantSkus = entry.skuIds.length
            ? productSkus.filter((s) => entry.skuIds.some((id) => id.equals(s._id)))
            : productSkus;
        return {
            entryId: entry.entryId,
            source: entry.source,
            productId: productKey,
            brand: product?.brand ?? '—',
            technical: product?.technical ?? '—',
            manufacturerName: manufacturer?.name ?? '—',
            productState: product?.state ?? 'live',
            packsDetailed: entry.skuIds.length > 0,
            packs: relevantSkus.map((s) => {
                const skuKey = s._id.toString();
                return {
                    skuId: skuKey,
                    packLabel: s.packLabel,
                    skuState: s.state,
                    listed: rateBySkuId.has(skuKey),
                    listingRatePaise: rateBySkuId.get(skuKey) ?? null,
                };
            }),
            setAt: entry.setAt.toISOString(),
            setBy: entry.setBy ? entry.setBy.toString() : null,
        };
    });
}
/**
 * B-04 — the one read behind every "how many sellers carry/list this" count
 * on the Purchase desk: the products' Analysis tab (`getProductFunnel`'s
 * `sellerCount`) and both Supply Matrix tabs each used to run their own,
 * separately-written query over `SellerCatalogueEntry`/`Listing` and could
 * drift apart. This is the shared aggregate, the same "one source of truth"
 * discipline `chain.view.ts` uses for the wall-projected chain view.
 *
 * `productId` narrows both queries for a single-product caller
 * (`getProductFunnel`); omitted, it builds the whole-catalogue picture the
 * two Supply Matrix tabs need. Return type is inferred rather than
 * re-declared — the exact seller-catalogue-entry document shape is
 * Mongoose's to define, not this function's to repeat.
 */
async function computeSellerCatalogueCoverage(productId) {
    const entries = await resolveCatalogueEntries(productId ? { productId } : {});
    const carrySellersByProduct = new Map();
    const entriesBySeller = new Map();
    for (const e of entries) {
        const productKey = e.productId.toString();
        const sellerKey = e.sellerId.toString();
        if (!carrySellersByProduct.has(productKey))
            carrySellersByProduct.set(productKey, new Set());
        carrySellersByProduct.get(productKey).add(sellerKey);
        if (!entriesBySeller.has(sellerKey))
            entriesBySeller.set(sellerKey, []);
        entriesBySeller.get(sellerKey).push(e);
    }
    // `Listing.productId` is direct — every line under a listing belongs to
    // the same product it was created for, so this needs no SKU join.
    const liveListings = await Listing.find(productId ? { state: 'live', productId } : { state: 'live' });
    const listedSellersByProduct = new Map();
    const listedProductIdsBySeller = new Map();
    for (const l of liveListings) {
        const productKey = l.productId.toString();
        const sellerKey = l.sellerId.toString();
        if (!listedSellersByProduct.has(productKey))
            listedSellersByProduct.set(productKey, new Set());
        listedSellersByProduct.get(productKey).add(sellerKey);
        if (!listedProductIdsBySeller.has(sellerKey))
            listedProductIdsBySeller.set(sellerKey, new Set());
        listedProductIdsBySeller.get(sellerKey).add(productKey);
    }
    return {
        carrySellersByProduct,
        listedSellersByProduct,
        entriesBySeller,
        listedProductIdsBySeller,
    };
}
export async function getSupplyMatrixByProduct() {
    const products = await Product.find({ active: true });
    const manufacturers = await Manufacturer.find({});
    const manufacturerById = new Map(manufacturers.map((m) => [m._id.toString(), m]));
    const { carrySellersByProduct, listedSellersByProduct } = await computeSellerCatalogueCoverage();
    return products.map((p) => {
        const key = p._id.toString();
        const manufacturer = manufacturerById.get(p.manufacturerId.toString());
        return {
            productId: key,
            brand: p.brand,
            technical: p.technical,
            manufacturerName: manufacturer?.name ?? '—',
            productState: p.state,
            class: p.class,
            carryCount: carrySellersByProduct.get(key)?.size ?? 0,
            listedCount: listedSellersByProduct.get(key)?.size ?? 0,
        };
    });
}
export async function getSupplyMatrixCallList(productId) {
    const skus = await Sku.find({ productId });
    const asks = await Ask.find({
        state: { $in: ['open', 'quoted'] },
        $or: [{ productId }, { skuId: { $in: skus.map((s) => s._id) } }],
    });
    const bySeller = new Map();
    for (const ask of asks) {
        const states = await getAskSellerStates(ask._id.toString());
        for (const s of states) {
            if (s.state === 'quoted' || bySeller.has(s.sellerId))
                continue;
            bySeller.set(s.sellerId, {
                sellerId: s.sellerId,
                firm: s.firm,
                state: s.state,
                ratePaise: s.ratePaise,
            });
        }
    }
    return [...bySeller.values()];
}
export async function getSupplyMatrixBySeller() {
    const sellers = await Seller.find({});
    const counterparties = await Counterparty.find({
        _id: { $in: sellers.map((s) => s.counterpartyId) },
    });
    const counterpartyById = new Map(counterparties.map((c) => [c._id.toString(), c]));
    const { entriesBySeller, listedProductIdsBySeller } = await computeSellerCatalogueCoverage();
    const allEntries = [...entriesBySeller.values()].flat();
    const products = await Product.find({ _id: { $in: allEntries.map((e) => e.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    // A company he deals in shows even before it has a single product.
    const dealerships = await SellerDealership.find({});
    const manufacturers = await Manufacturer.find({
        _id: {
            $in: [...products.map((p) => p.manufacturerId), ...dealerships.map((d) => d.manufacturerId)],
        },
    });
    const manufacturerById = new Map(manufacturers.map((m) => [m._id.toString(), m]));
    const dealershipNamesBySeller = new Map();
    for (const d of dealerships) {
        const name = manufacturerById.get(d.manufacturerId.toString())?.name;
        if (!name)
            continue;
        const key = d.sellerId.toString();
        dealershipNamesBySeller.set(key, [...(dealershipNamesBySeller.get(key) ?? []), name]);
    }
    return sellers.map((s) => {
        const key = s._id.toString();
        const myEntries = entriesBySeller.get(key) ?? [];
        const myListedProductIds = listedProductIdsBySeller.get(key) ?? new Set();
        const manufacturerNames = [
            ...new Set([
                ...(dealershipNamesBySeller.get(key) ?? []),
                ...myEntries.map((e) => {
                    const product = productById.get(e.productId.toString());
                    const manufacturer = product
                        ? manufacturerById.get(product.manufacturerId.toString())
                        : undefined;
                    return manufacturer?.name ?? '—';
                }),
            ]),
        ].sort((a, b) => a.localeCompare(b));
        return {
            sellerId: key,
            firm: counterpartyById.get(s.counterpartyId.toString())?.firm ?? '—',
            trustTier: s.trustTier,
            carryCount: myEntries.length,
            listedCount: myEntries.filter((e) => myListedProductIds.has(e.productId.toString())).length,
            manufacturerNames,
        };
    });
}
export async function getPilesAwaitingDecision() {
    const piles = await Pile.find({ decision: null }).sort({ openedAt: 1 });
    const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
    const lineById = new Map(lines.map((l) => [l._id.toString(), l]));
    const listings = await Listing.find({ _id: { $in: lines.map((l) => l.listingId) } });
    const listingById = new Map(listings.map((l) => [l._id.toString(), l]));
    const sellers = await Seller.find({ _id: { $in: listings.map((l) => l.sellerId) } });
    const sellerById = new Map(sellers.map((s) => [s._id.toString(), s]));
    const firmBySellerId = await getFirmBySellerId(listings.map((l) => l.sellerId));
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const requests = await PileRequest.find({ pileId: { $in: piles.map((p) => p._id) } });
    const now = Date.now();
    return piles.map((pile) => {
        const line = lineById.get(pile.listingLineId.toString());
        const listing = line
            ? listingById.get(line.listingId.toString())
            : undefined;
        const sellerId = listing ? listing.sellerId.toString() : '';
        const seller = sellerById.get(sellerId);
        const sku = line ? skuById.get(line.skuId.toString()) : undefined;
        const product = sku ? productById.get(sku.productId.toString()) : undefined;
        const myRequests = requests.filter((r) => r.pileId.equals(pile._id));
        const boxes = myRequests.reduce((sum, r) => sum + r.qty, 0);
        const lineQty = line?.qty ?? 0;
        // The one gap this data can actually support without inventing a
        // signal the seller hasn't given yet: what he originally said he had
        // (the listing line's own `qty`) against what buyers have now piled on
        // top of it. Anything finer (why he's short) is his to say when he
        // answers — that's exactly what Confirm/Requote/Decline is for.
        const gapText = boxes > lineQty ? `${boxes} of ${lineQty} boxes in his listing` : null;
        return {
            pileId: pile._id.toString(),
            sellerId,
            sellerCounterpartyId: seller ? seller.counterpartyId.toString() : '',
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            skuId: line ? line.skuId.toString() : '',
            packLabel: sku?.packLabel ?? '—',
            brand: product?.brand ?? '—',
            ratePaise: line?.ratePaise ?? 0,
            boxes,
            lineQty,
            buyers: new Set(myRequests.map((r) => r.buyerId.toString())).size,
            openedAt: pile.openedAt.toISOString(),
            confirmWindowEndsAt: pile.confirmWindowEndsAt.toISOString(),
            chaseLeftHours: Math.round(((pile.confirmWindowEndsAt.getTime() - now) / (60 * 60 * 1000)) * 10) / 10,
            gapText,
        };
    });
}
export async function getDispatchChaseQueue(sellerId) {
    const now = Date.now();
    const sellerFilter = sellerId ? { sellerId } : {};
    const [released, dispatchedLeg1] = await Promise.all([
        Po.find({ state: 'released', failed: false, ...sellerFilter }),
        Po.find({ state: 'dispatched_leg1', failed: false, receivedAt: null, ...sellerFilter }),
    ]);
    // Dispatch holds what Purchase has handed over after the seller invoiced it. A PO that is
    // still on the PO or Billed screen stays there — unless the dispatch-clock job has already
    // marked it missed (same-day or 48-hour, BR-174/BR-215): a missed obligation must never be
    // hidden by which screen the PO happens to sit on. (`dispatchDueDate` itself is the release
    // moment, so it cannot be the test — every new PO would count as overdue at once.)
    const pending = released.filter((po) => po.handedToDispatchAt || po.sameDayMissAt || po.noDispatch48hAt);
    const allPos = [...pending, ...dispatchedLeg1];
    const movements = await Movement.find({
        chainId: { $in: dispatchedLeg1.map((p) => p.chainId) },
        leg: 1,
    });
    const movementByChain = new Map(movements.map((m) => [m.chainId.toString(), m]));
    const firmBySellerId = await getFirmBySellerId(allPos.map((p) => p.sellerId));
    const sellers = await Seller.find({ _id: { $in: allPos.map((p) => p.sellerId) } });
    const cutoffBySellerId = new Map(sellers.map((s) => [s._id.toString(), s.dispatchCutoffTime]));
    // Goods — the PO's own line, joined through to the product/pack it names.
    // A PO carries exactly one line (Q4/BR-030's own single-SKU-per-order design).
    const poLines = await PoLine.find({ poId: { $in: allPos.map((p) => p._id) } });
    const poLineByPoId = new Map(poLines.map((l) => [l.poId.toString(), l]));
    const skus = await Sku.find({ _id: { $in: poLines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    function goodsFor(poId) {
        const line = poLineByPoId.get(poId);
        const sku = line ? skuById.get(line.skuId.toString()) : undefined;
        const product = sku ? productById.get(sku.productId.toString()) : undefined;
        return {
            brand: product?.brand ?? '—',
            packLabel: sku?.packLabel ?? '—',
            boxes: line?.boxes ?? 0,
        };
    }
    const dueOrOverdue = pending.map((po) => {
        const hoursLeft = (po.dispatchDueDate.getTime() - now) / (60 * 60 * 1000);
        const sellerId = po.sellerId.toString();
        return {
            poId: po._id.toString(),
            poNo: po.poNo,
            sellerId,
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            sellerCutoffTime: cutoffBySellerId.get(sellerId) ?? '—',
            ...goodsFor(po._id.toString()),
            bucket: hoursLeft < 0 ? 'overdue' : 'due',
            dispatchDueDate: po.dispatchDueDate.toISOString(),
            hoursLeft: Math.round(hoursLeft * 10) / 10,
            sameDayMiss: !!po.sameDayMissAt,
            noDispatch48h: !!po.noDispatch48hAt,
            dispatchedAt: null,
            daysInTransit: null,
            invoiceRecorded: !!po.sellerInvoiceNo,
        };
    });
    const inTransit = dispatchedLeg1.map((po) => {
        const movement = movementByChain.get(po.chainId.toString());
        const dispatchedAt = movement?.dispatchedAt ?? null;
        const sellerId = po.sellerId.toString();
        return {
            poId: po._id.toString(),
            poNo: po.poNo,
            sellerId,
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            sellerCutoffTime: cutoffBySellerId.get(sellerId) ?? '—',
            ...goodsFor(po._id.toString()),
            bucket: 'in_transit',
            dispatchDueDate: po.dispatchDueDate.toISOString(),
            hoursLeft: null,
            sameDayMiss: !!po.sameDayMissAt,
            noDispatch48h: !!po.noDispatch48hAt,
            dispatchedAt: dispatchedAt ? dispatchedAt.toISOString() : null,
            daysInTransit: dispatchedAt
                ? Math.floor((now - dispatchedAt.getTime()) / (24 * 60 * 60 * 1000))
                : null,
            invoiceRecorded: !!po.sellerInvoiceNo,
        };
    });
    return [...dueOrOverdue, ...inTransit].sort((a, b) => (a.hoursLeft ?? 0) - (b.hoursLeft ?? 0));
}
/** A logged chase, not a state change — the dispatch clock itself is untouched. */
export async function logDispatchChase(poId, actor) {
    const po = await Po.findById(poId);
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'po',
        entityId: po._id,
        field: 'dispatch_chase_logged',
        correlationId: actor.correlationId,
    });
}
/** The same logged-chase pattern as `logDispatchChase`, for an ask instead
 * of a PO — a seller who is 'listed' or 'carries' but hasn't quoted this
 * ask yet. Never a state change, just an audit trail Purchase can point to. */
export async function logAskChase(askId, sellerId, actor) {
    const ask = await Ask.findById(askId);
    if (!ask)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'ask',
        entityId: ask._id,
        field: 'ask_chase_logged',
        reason: `Seller ${sellerId} chased.`,
        correlationId: actor.correlationId,
    });
}
/** The same logged-chase pattern as `logDispatchChase`/`logAskChase`, for a
 * pile still waiting on the one seller it's piled against. */
export async function logPileChase(pileId, actor) {
    const pile = await Pile.findById(pileId);
    if (!pile)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'pile',
        entityId: pile._id,
        field: 'pile_chase_logged',
        correlationId: actor.correlationId,
    });
}
export async function getInspectionsPendingApply() {
    const inspections = await Inspection.find({}).sort({ signedAt: 1 });
    const pos = await Po.find({
        _id: { $in: inspections.map((i) => i.poId) },
        inspected: false,
        failed: false,
    });
    const poById = new Map(pos.map((p) => [p._id.toString(), p]));
    const firmBySellerId = await getFirmBySellerId(pos.map((p) => p.sellerId));
    return inspections
        .filter((i) => poById.has(i.poId.toString()))
        .map((i) => {
        const po = poById.get(i.poId.toString());
        const sellerId = po.sellerId.toString();
        return {
            inspectionId: i._id.toString(),
            poId: po._id.toString(),
            poNo: po.poNo,
            sellerId,
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            casesAccepted: i.casesAccepted,
            casesRejected: i.casesRejected,
            reasons: i.reasons,
            signedAt: i.signedAt.toISOString(),
            wholeLot: i.casesAccepted === 0,
        };
    });
}
export async function getOpenDemandForSeller(sellerId) {
    const entries = await resolveCatalogueEntries({ sellerId });
    if (entries.length === 0)
        return [];
    const productIds = entries.map((e) => e.productId);
    const skus = await Sku.find({ productId: { $in: productIds } });
    const skuIds = skus.map((s) => s._id);
    const asks = await Ask.find({
        state: { $in: ['open', 'quoted'] },
        $or: [{ productId: { $in: productIds } }, { skuId: { $in: skuIds } }],
    }).sort({ createdAt: 1 });
    const quotes = await Quote.find({ askId: { $in: asks.map((a) => a._id) }, sellerId });
    const quotedAskIds = new Set(quotes.map((q) => q.askId.toString()));
    // An ask carries a product or only a SKU — resolve either to the product so the
    // seller file can show a name, never the raw ask id.
    const productIdBySkuId = new Map(skus.map((s) => [
        s._id.toString(),
        s.productId.toString(),
    ]));
    const askProductId = (a) => a.productId
        ? a.productId.toString()
        : a.skuId
            ? (productIdBySkuId.get(a.skuId.toString()) ?? null)
            : null;
    const products = await Product.find({
        _id: { $in: [...new Set(asks.map(askProductId).filter((id) => id !== null))] },
    });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const now = Date.now();
    return asks.map((a) => {
        const productId = askProductId(a);
        const product = productId ? productById.get(productId) : undefined;
        return {
            askId: a._id.toString(),
            skuId: a.skuId ? a.skuId.toString() : null,
            productId: a.productId ? a.productId.toString() : null,
            qty: a.qty,
            ageHours: Math.round(((now - a.createdAt.getTime()) / (60 * 60 * 1000)) *
                10) / 10,
            hasQuoted: quotedAskIds.has(a._id.toString()),
            brand: product?.brand ?? '—',
            technical: product?.technical ?? '—',
        };
    });
}
export async function getSellerFile(sellerId) {
    const seller = await Seller.findById(sellerId);
    if (!seller)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
    const counterparty = await Counterparty.findById(seller.counterpartyId);
    if (!counterparty)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Counterparty not found.' });
    const [areas, references, debits, returnNotes, catalogue, dealerships, listings, scorecard, openDemand, performance,] = await Promise.all([
        SellerArea.find({ sellerId: seller._id }),
        SellerReference.find({ sellerId: seller._id }),
        SellerDebit.find({ counterpartyId: seller._id, nettedAgainst: null }),
        ReturnNote.find({ sellerId: seller._id, returnedAt: null }),
        getSellerCatalogue(sellerId),
        getSellerDealerships(sellerId),
        Listing.find({ sellerId: seller._id, state: 'live' }),
        getSellerScorecard(seller.counterpartyId.toString()),
        getOpenDemandForSeller(sellerId),
        getSellerFunnelMetrics(sellerId),
    ]);
    const tehsils = await Tehsil.find({ _id: { $in: areas.map((a) => a.tehsilId) } });
    const tehsilById = new Map(tehsils.map((t) => [t._id.toString(), t]));
    const lines = await ListingLine.find({ listingId: { $in: listings.map((l) => l._id) } });
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const listingById = new Map(listings.map((l) => [l._id.toString(), l]));
    const now = Date.now();
    const listingDtos = lines.map((line) => {
        const listing = listingById.get(line.listingId.toString());
        const sku = skuById.get(line.skuId.toString());
        const lastProxy = line.proxyLog.length ? line.proxyLog[line.proxyLog.length - 1] : null;
        return {
            listingId: listing ? listing._id.toString() : '',
            lineId: line._id.toString(),
            skuId: line.skuId.toString(),
            packLabel: sku?.packLabel ?? '—',
            ratePaise: line.ratePaise,
            scopeType: listing?.scopeType ?? '',
            createdAt: line.createdAt.toISOString(),
            deskEntered: line.proxyLog.length > 0,
            enteredBy: lastProxy ? lastProxy.actingStaffId.toString() : null,
            callNote: lastProxy ? lastProxy.callNote : null,
        };
    });
    return {
        sellerId,
        counterpartyId: seller.counterpartyId.toString(),
        firm: counterparty.firm ?? '—',
        gstin: counterparty.gstin ?? '—',
        ownerName: counterparty.ownerName ?? '—',
        mobile: counterparty.mobile,
        licenceNo: counterparty.licenceNo ?? '—',
        trustTier: seller.trustTier,
        dispatchCutoffTime: seller.dispatchCutoffTime,
        suppliesCompleted: seller.suppliesCompleted,
        since: seller.createdAt.toISOString(),
        area: areas.map((a) => {
            const tehsil = tehsilById.get(a.tehsilId.toString());
            return {
                tehsilId: a.tehsilId.toString(),
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
        performance,
        openDebits: debits.map((d) => ({
            debitId: d._id.toString(),
            reason: d.reason,
            amountPaise: d.amountPaise,
            netted: !!d.nettedAgainst,
        })),
        openReturnNotes: returnNotes.map((r) => {
            const daysOld = Math.floor((now - r.raisedAt.getTime()) / (24 * 60 * 60 * 1000));
            return {
                returnNoteId: r._id.toString(),
                poId: r.poId.toString(),
                cases: r.cases,
                daysOld,
                dueDate: r.dueBy.toISOString(),
                overdue: daysOld > RETURN_NOTE_WINDOW_DAYS,
            };
        }),
        catalogue,
        dealerships,
        listings: listingDtos,
        openDemand: openDemand.filter((d) => !d.hasQuoted),
    };
}
export async function getOpenSellerDebits() {
    const debits = await SellerDebit.find({ nettedAgainst: null }).sort({ createdAt: -1 });
    const firmBySellerId = await getFirmBySellerId(debits.map((d) => d.counterpartyId));
    return debits.map((d) => {
        const sellerId = d.counterpartyId.toString();
        return {
            debitId: d._id.toString(),
            sellerId,
            sellerFirm: firmBySellerId.get(sellerId) ?? '—',
            reason: d.reason,
            amountPaise: d.amountPaise,
            raisedAt: d.createdAt.toISOString(),
        };
    });
}
export async function getProductFunnel(productId, now = new Date()) {
    const from = addDays(now, -FUNNEL_WINDOW_DAYS);
    const skus = await Sku.find({ productId });
    const skuIds = skus.map((s) => s._id);
    const [windowAsks, openAsks, coverage] = await Promise.all([
        Ask.find({
            createdAt: { $gte: from },
            $or: [{ productId }, { skuId: { $in: skuIds } }],
        }),
        Ask.find({
            state: { $in: ['open', 'quoted'] },
            $or: [{ productId }, { skuId: { $in: skuIds } }],
        }),
        // B-04 — the same shared read the Supply Matrix tabs use, so this
        // column can never drift from theirs again.
        computeSellerCatalogueCoverage(productId),
    ]);
    const sellerCount = coverage.carrySellersByProduct.get(productId)?.size ?? 0;
    const quotedAskIds = new Set((await Quote.find({ askId: { $in: windowAsks.map((a) => a._id) } })).map((q) => q.askId.toString()));
    const quoted = windowAsks.filter((a) => quotedAskIds.has(a._id.toString())).length;
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
export async function getProductFunnelAll() {
    const products = await Product.find({ active: true }).sort({ brand: 1 });
    const now = new Date();
    const rows = [];
    for (const product of products) {
        rows.push(await getProductFunnel(product._id.toString(), now));
    }
    return rows;
}
export async function getProductAnalysisAll() {
    const products = await Product.find({ active: true }).sort({ brand: 1 });
    const results = [];
    for (const product of products) {
        results.push(await getProductAnalysis(product._id.toString()));
    }
    return results;
}
