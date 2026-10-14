import mongoose from 'mongoose';
import { Listing } from '../../models/Listing.js';
import { withTransaction } from '../../db/transaction.js';
import { createTradeEnquiryInSession } from '../enquiry/enquiry.sync.js';
import { derivePileRequestStatus } from '../enquiry/enquiry.status.js';
import { ListingLine, deriveMoqBand, } from '../../models/ListingLine.js';
import { Seller } from '../../models/Seller.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { Buyer } from '../../models/Buyer.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Tehsil } from '../../models/Tehsil.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { Manufacturer } from '../../models/Manufacturer.js';
import { Pool, buildConditionSetKey } from '../../models/Pool.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { BuyerLocation } from '../../models/BuyerLocation.js';
import { AppError } from '../../shared/errors.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { writeAuditLog } from '../../shared/audit.js';
import { assertCounterpartyActive } from '../../shared/guards.js';
import { computeBuyerInclusiveRatePaise } from '../../shared/pricing.js';
import { resolveMarginMatrixCell } from '../pricing/pricing.service.js';
import { resolveSkuClass, toRateTier } from '../chain/chain.service.js';
import { resolveVisibility } from '../territory/resolver.js';
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
export async function computeBuyerFacingRatePaise(buyer, skuId, sellerNetPaise) {
    const marginPct = await marginPctForBuyerAndSku(buyer, skuId);
    return marginPct === null ? null : computeBuyerInclusiveRatePaise(sellerNetPaise, marginPct);
}
/**
 * The margin a buyer's tier carries on this SKU's class, or `null` while the matrix has no
 * cell for it. It depends on the SKU and the buyer's tier only — never on the line's rate —
 * so a feed of 200 lines over 8 SKUs needs 8 of these, not 200 (M9: that N+1 was the
 * feed's whole ~1.3 s at a few hundred listings).
 */
async function marginPctForBuyerAndSku(buyer, skuId) {
    try {
        const { skuClass } = await resolveSkuClass(skuId);
        const cell = await resolveMarginMatrixCell(skuClass, toRateTier(buyer));
        return cell.pct;
    }
    catch (error) {
        if (error instanceof AppError && error.code === 'MARGIN_CELL_MISSING')
            return null;
        throw error;
    }
}
async function sellerBlockLookupFor(sellerId) {
    const blocks = await SellerBlock.find({ sellerId, status: 'active' }).select('gstin');
    const blockedGstins = new Set(blocks.map((b) => b.gstin));
    return (gstin) => blockedGstins.has(gstin);
}
async function resolveFrozenTehsilIds(sellerId, scopeType, customTehsilIds) {
    const ownAreaIds = (await SellerArea.find({ sellerId }).select('tehsilId')).map((a) => a.tehsilId);
    if (scopeType === 'my_area')
        return ownAreaIds;
    if (scopeType === 'all_india') {
        const all = await Tehsil.find({}).select('_id');
        return all.map((t) => t._id);
    }
    if (scopeType === 'all_except_mine') {
        const ownSet = new Set(ownAreaIds.map((id) => id.toString()));
        const all = await Tehsil.find({}).select('_id');
        return all.map((t) => t._id).filter((id) => !ownSet.has(id.toString()));
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
    return found.map((t) => t._id);
}
function assertShelfLifeMeetsFloor(expiryBand, expiryExact) {
    // BR-107 — six clear months, enforced at listing time. `expiryExact` is an
    // expectation (BR-102), but when a seller does supply one up front it is
    // still checked against the floor rather than accepted blindly.
    if (!expiryExact)
        return;
    const [monthStr, yearStr] = expiryExact.split('/');
    const month = Number(monthStr);
    const year = Number(yearStr);
    if (!month || !year)
        return;
    const expiryDate = new Date(year, month - 1, 1);
    if (expiryDate.getTime() - Date.now() < SIX_MONTHS_MS) {
        throw new AppError({
            code: 'SHELF_LIFE_FLOOR',
            messageEn: 'A listing under six months of remaining shelf life cannot be created (BR-107).',
            field: 'expiryExact',
        });
    }
}
function assertBatchRequiredForAuth(provenance, batch) {
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
export async function createListing(sellerCounterpartyId, input) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    if (!seller)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    await assertCounterpartyActive(sellerCounterpartyId); // QR-015 — blacklist blocks new listings.
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
    // Purchase-desk v2, LOCK-26-style amendment — a draft product/pack/company
    // (raised by Purchase mid-call, `CATALOG_DRAFT_CREATE`) works in a seller's
    // catalogue at once but cannot back a live listing until Admin confirms it.
    // Checked once here, ahead of the per-line loop, so both the seller's own
    // create-listing screen and the desk's proxy path (which calls this same
    // function) are refused identically — never a second, looser path.
    const product = await Product.findById(input.productId);
    if (!product) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Product not found.',
            field: 'productId',
        });
    }
    if (product.state === 'draft') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This product is still a draft — Admin has not confirmed it yet.',
            field: 'productId',
        });
    }
    const manufacturer = await Manufacturer.findById(product.manufacturerId);
    if (manufacturer?.state === 'draft') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This product’s company is still a draft — Admin has not confirmed it yet.',
            field: 'productId',
        });
    }
    for (const line of input.lines) {
        assertShelfLifeMeetsFloor(line.expiryBand, line.expiryExact);
        assertBatchRequiredForAuth(line.provenance, line.batch);
        const sku = await Sku.findOne({ _id: line.skuId, productId: input.productId });
        if (!sku) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'One or more SKUs do not belong to this product.',
                field: 'skuId',
            });
        }
        if (sku.state === 'draft') {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'This pack is still a draft — Admin has not confirmed it yet.',
                field: 'skuId',
            });
        }
    }
    // B-03 — refuse an exact duplicate rather than silently creating a second,
    // identical live listing line (a double-submit, not a genuine re-list;
    // BR-087's "no merge rule" is about two DIFFERENT rates/scopes coexisting).
    const sellersLiveListingIds = await Listing.find({
        sellerId: seller._id,
        productId: input.productId,
        state: 'live',
    }).distinct('_id');
    for (const line of input.lines) {
        const moqBand = deriveMoqBand(line.moqExact ?? 1);
        const duplicate = await ListingLine.findOne({
            listingId: { $in: sellersLiveListingIds },
            skuId: line.skuId,
            ratePaise: line.ratePaise,
            expiryBand: line.expiryBand,
            moqBand,
            deliveryBand: line.deliveryBand,
            provenance: line.provenance,
        });
        if (duplicate) {
            throw new AppError({
                code: 'DUPLICATE_LISTING',
                messageEn: 'You already have a live listing at this exact rate and condition set on this pack.',
                field: 'ratePaise',
                meta: { existingListingLineId: duplicate._id.toString() },
            });
        }
    }
    const frozenTehsilIds = await resolveFrozenTehsilIds(seller._id, input.scopeType, input.customTehsilIds);
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
    const lineIds = [];
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
        lineIds.push(created._id.toString());
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
    return { listingId: listing._id.toString(), lineIds };
}
async function openOrJoinPool(skuId, moqExact, key) {
    const conditionSetKey = buildConditionSetKey(key);
    const existing = await Pool.findOne({ skuId, conditionSetKey, isActive: true });
    if (existing)
        return; // BR-151 — a pool belongs to the condition set, not to one seller's listing.
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
/** API-034. My stock — listings with days remaining, filterable by origin and state. */
export async function getMyListings(sellerCounterpartyId, filters) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    if (!seller)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    const query = { sellerId: seller._id };
    if (filters.state)
        query.state = filters.state;
    const listings = await Listing.find(query).sort({ createdAt: -1 });
    const listingIds = listings.map((l) => l._id);
    const lines = await ListingLine.find({ listingId: { $in: listingIds } });
    const listingById = new Map(listings.map((l) => [l._id.toString(), l]));
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const now = Date.now();
    return lines.map((line) => {
        const listing = listingById.get(line.listingId.toString());
        const sku = skuById.get(line.skuId.toString());
        return {
            listingId: listing._id.toString(),
            listingLineId: line._id.toString(),
            skuId: line.skuId.toString(),
            packLabel: sku?.packLabel ?? '',
            ratePaise: line.ratePaise,
            qty: line.qty,
            expiryBand: line.expiryBand,
            moqBand: line.moqBand,
            deliveryBand: line.deliveryBand,
            provenance: line.provenance,
            state: listing.state,
            expiresAt: listing.expiresAt,
            daysRemaining: Math.max(0, Math.ceil((listing.expiresAt.getTime() - now) / (24 * 60 * 60 * 1000))),
        };
    });
}
/** API-036 pause. */
export async function pauseListing(sellerCounterpartyId, listingId) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    const listing = await Listing.findOne({ _id: listingId, sellerId: seller?._id });
    if (!listing)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
    listing.state = 'paused';
    listing.pausedAt = new Date();
    await listing.save();
}
/** API-036 relist — BR-108, one tap, history preserved (a fresh 45-day window on the same listing). */
export async function relistListing(sellerCounterpartyId, listingId) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    const listing = await Listing.findOne({ _id: listingId, sellerId: seller?._id });
    if (!listing)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
    listing.state = 'live';
    listing.pausedAt = null;
    listing.expiresAt = new Date(Date.now() + LISTING_LIFE_DAYS * 24 * 60 * 60 * 1000);
    listing.dropReminderSentAt = null; // A fresh 45-day window earns a fresh reminder (BR-108).
    await listing.save();
}
/** API-035. BR-109 — gated by size, not direction. */
export async function changeListingLineRate(sellerCounterpartyId, listingLineId, input, actor) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    const line = await ListingLine.findById(listingLineId);
    if (!line)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });
    const listing = await Listing.findOne({ _id: line.listingId, sellerId: seller?._id });
    if (!listing)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });
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
        actorId: seller.counterpartyId,
        actorType: 'counterparty',
        entity: 'listing_line',
        entityId: line._id,
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
async function requireActiveBuyer(buyerCounterpartyId) {
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    if (!buyer)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
    if (!buyer.tehsilId) {
        throw new AppError({
            code: 'NO_AREA_SET',
            messageEn: 'Your tehsil is not yet set — contact support.',
        });
    }
    const counterparty = await Counterparty.findById(buyer.counterpartyId);
    return { buyer, counterparty: counterparty };
}
/** Attaches this buyer's own tier rate to each line, dropping any whose class/tier cell is still missing. */
async function priceForBuyer(buyer, lines) {
    // One margin lookup per distinct SKU, not per line.
    const skuIds = [...new Set(lines.map((v) => String(v.line.skuId)))];
    const marginBySku = new Map();
    await Promise.all(skuIds.map(async (skuId) => {
        marginBySku.set(skuId, await marginPctForBuyerAndSku(buyer, skuId));
    }));
    const priced = [];
    for (const v of lines) {
        const marginPct = marginBySku.get(String(v.line.skuId));
        if (marginPct === null || marginPct === undefined)
            continue; // the cell is still missing
        priced.push({
            ...v,
            buyerRatePaise: computeBuyerInclusiveRatePaise(v.line.ratePaise, marginPct),
        });
    }
    return priced;
}
/**
 * WF-03 — the one resolver, called here and nowhere else for buyer reads.
 * Loads every live line whose frozen tehsil set contains the buyer's
 * tehsil (the resolver's hot path, indexed), then re-checks
 * `resolveVisibility` per listing for the self-dealing and block cases the
 * index alone cannot express.
 */
async function findVisibleLines(buyerTehsilId, buyerCounterpartyId, buyerGstin) {
    const listings = await Listing.find({ state: 'live', frozenTehsilIds: buyerTehsilId });
    const sellerIds = [...new Set(listings.map((l) => l.sellerId.toString()))];
    const sellers = await Seller.find({ _id: { $in: sellerIds } });
    const sellerCounterpartyById = new Map(sellers.map((s) => [
        s._id.toString(),
        s.counterpartyId.toString(),
    ]));
    const blockLookups = new Map();
    for (const sellerId of sellerIds) {
        blockLookups.set(sellerId, await sellerBlockLookupFor(sellerId));
    }
    const visibleListings = listings.filter((listing) => {
        const sellerId = listing.sellerId.toString();
        const sellerCounterpartyId = sellerCounterpartyById.get(sellerId);
        if (!sellerCounterpartyId)
            return false;
        return resolveVisibility({
            sellerId: sellerCounterpartyId,
            frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
        }, { gstin: buyerGstin, tehsilId: buyerTehsilId, counterpartyId: buyerCounterpartyId }, blockLookups.get(sellerId));
    });
    const listingById = new Map(visibleListings.map((l) => [l._id.toString(), l]));
    const lines = await ListingLine.find({
        listingId: { $in: visibleListings.map((l) => l._id) },
        qty: { $gt: 0 },
    });
    return lines
        .filter((line) => listingById.has(line.listingId.toString()))
        .map((line) => ({
        line,
        listing: listingById.get(line.listingId.toString()),
    }));
}
/**
 * Staff read for the Sales call workspace ("On the board for him", client item 16).
 * Exactly the lines this buyer's own feed would show him, priced as he sees them
 * (BR-060) — driven by what reaches his tehsil, never by what he has ordered.
 *
 * Keyed on `Buyer._id` because that is the id the Sales screens hold; it resolves the
 * counterparty itself so the one resolver (`findVisibleLines`) is called here too and
 * nowhere else. A buyer with no tehsil yet has nothing reaching him.
 */
export async function listPricedLinesVisibleToBuyerDoc(buyerDocId) {
    assertValidObjectId(buyerDocId, 'buyerId');
    const buyer = await Buyer.findById(buyerDocId);
    if (!buyer)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
    if (!buyer.tehsilId)
        return [];
    const counterparty = await Counterparty.findById(buyer.counterpartyId);
    const visible = await findVisibleLines(buyer.tehsilId.toString(), buyer.counterpartyId.toString(), counterparty?.gstin ?? '');
    return priceForBuyer(buyer, visible);
}
function toConditionTags(line) {
    return {
        expiryBand: line.expiryBand,
        moqBand: line.moqBand,
        deliveryBand: line.deliveryBand,
        provenance: line.provenance,
        ...(line.expiryFixed && line.expiryExact ? { expiryExact: line.expiryExact } : {}),
    };
}
/** API-030. BR-110 — one card per product, cheapest first, newest groups first. */
export async function getBuyerFeed(buyerCounterpartyId, cursor, limit) {
    const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
    const visible = await findVisibleLines(buyer.tehsilId.toString(), buyerCounterpartyId, counterparty.gstin ?? '');
    const priced = await priceForBuyer(buyer, visible);
    const productIds = [
        ...new Set(priced.map((v) => v.listing.productId.toString())),
    ];
    const products = await Product.find({ _id: { $in: productIds } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const byProduct = new Map();
    for (const v of priced) {
        const productId = v.listing.productId.toString();
        const group = byProduct.get(productId) ?? [];
        group.push(v);
        byProduct.set(productId, group);
    }
    const cards = [];
    for (const [productId, lines] of byProduct) {
        const product = productById.get(productId);
        if (!product)
            continue;
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
        const aLatest = Math.max(...(byProduct.get(a.productId) ?? []).map((v) => v.listing.createdAt.getTime()));
        const bLatest = Math.max(...(byProduct.get(b.productId) ?? []).map((v) => v.listing.createdAt.getTime()));
        return bLatest - aLatest;
    });
    const page = cards.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < cards.length ? cursor + limit : undefined;
    return { items: page, nextCursor };
}
/** API-031. Every rate on a product, cheapest first, plus pools on that product. */
export async function getProductOffers(buyerCounterpartyId, productId) {
    const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
    const visible = await findVisibleLines(buyer.tehsilId.toString(), buyerCounterpartyId, counterparty.gstin ?? '');
    const priced = await priceForBuyer(buyer, visible.filter((v) => v.listing.productId.toString() === productId));
    priced.sort((a, b) => a.buyerRatePaise - b.buyerRatePaise);
    const skuIds = [...new Set(priced.map((v) => v.line.skuId.toString()))];
    const pools = await Pool.find({ skuId: { $in: skuIds }, isActive: true });
    return {
        offers: priced.map((v) => ({
            listingLineId: v.line._id.toString(),
            ratePaise: v.buyerRatePaise,
            conditions: toConditionTags(v.line),
            hasPool: pools.some((p) => p.skuId.toString() === v.line.skuId.toString()),
        })),
        pools: pools.map((p) => ({
            poolId: p._id.toString(),
            skuId: p.skuId.toString(),
            moq: p.moq,
            status: p.status,
        })),
    };
}
/** API-032. The buy screen. Server-side visibility re-checked, never trusted from a link. */
export async function getListingLineForBuy(buyerCounterpartyId, listingLineId) {
    const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
    const line = await ListingLine.findById(listingLineId);
    const listing = line ? await Listing.findById(line.listingId) : null;
    // WF-03 — a direct link to something outside scope returns the same
    // shape and the same latency as something that does not exist (BR-065).
    if (!line || !listing || listing.state !== 'live') {
        throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
    }
    const seller = await Seller.findById(listing.sellerId);
    const blockLookup = await sellerBlockLookupFor(listing.sellerId);
    const visible = resolveVisibility({
        sellerId: seller.counterpartyId.toString(),
        frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
    }, {
        gstin: counterparty.gstin ?? '',
        tehsilId: buyer.tehsilId.toString(),
        counterpartyId: buyerCounterpartyId,
    }, blockLookup);
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
        listingLineId: line._id.toString(),
        productId: listing.productId.toString(),
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
/**
 * New — not in the original `API_CONTRACT.md`, needed to actually submit
 * WF-04's buy screen (API-032 only describes the read). BR-093 — the
 * delivery location is not constrained by the listing's scope; an
 * out-of-scope delivery only raises a monitoring flag, it blocks nothing.
 * Creates a `pile` on first request against a line (BR-133); nothing is
 * charged and no clock runs against the seller.
 */
export async function createPileRequest(buyerCounterpartyId, listingLineId, input) {
    const { buyer, counterparty } = await requireActiveBuyer(buyerCounterpartyId);
    await assertCounterpartyActive(buyerCounterpartyId); // QR-015 — blacklist blocks new inquiries.
    const line = await ListingLine.findById(listingLineId);
    const listing = line ? await Listing.findById(line.listingId) : null;
    if (!line || !listing || listing.state !== 'live') {
        throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
    }
    const seller = await Seller.findById(listing.sellerId);
    const blockLookup = await sellerBlockLookupFor(listing.sellerId);
    const visible = resolveVisibility({
        sellerId: seller.counterpartyId.toString(),
        frozenTehsilIds: listing.frozenTehsilIds.map((id) => id.toString()),
    }, {
        gstin: counterparty.gstin ?? '',
        tehsilId: buyer.tehsilId.toString(),
        counterpartyId: buyerCounterpartyId,
    }, blockLookup);
    if (!visible)
        throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
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
    }
    else if (pile.decision) {
        throw new AppError({
            code: 'PILE_ALREADY_DECIDED',
            messageEn: 'This listing has already been decided.',
        });
    }
    // DEC-051 — the request and its enquiry are created together.
    const now = new Date();
    const requestId = new mongoose.Types.ObjectId();
    const enquiryId = await withTransaction(async (session) => {
        const enquiryId = await createTradeEnquiryInSession({
            kind: 'pile_request',
            channel: 'self',
            raisedAt: now,
            buyerId: buyer._id,
            skuId: line.skuId,
            productId: listing.productId,
            qty: input.qty,
            pileRequestId: requestId,
        }, derivePileRequestStatus({ decision: null, executedAt: null, shortfall: false }), session);
        await PileRequest.create([
            {
                _id: requestId,
                pileId: pile._id,
                buyerId: buyer._id,
                qty: input.qty,
                deliveryLocationId: location._id,
                requestedAt: now,
                enquiryId,
            },
        ], { session, ordered: true });
        return enquiryId;
    });
    return {
        pileId: pile._id.toString(),
        enquiryId: enquiryId ? enquiryId.toString() : null,
    };
}
/** Read-only for buyers (BR-094 — staff add locations, never self-serve). */
export async function listMyDeliveryLocations(buyerCounterpartyId) {
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    if (!buyer)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
    const locations = await BuyerLocation.find({ buyerId: buyer._id, deletedAt: null });
    return locations.map((l) => ({
        locationId: l._id.toString(),
        label: l.label,
        address: l.address,
        isPrimary: l.isPrimary,
    }));
}
// ---------------------------------------------------------------------------
// Seller-facing reads — BR-061/BR-062: rank and bands, never a rate.
// ---------------------------------------------------------------------------
const MIN_COMPARABLE = 3; // BR-062 — below this, the band does not render at all.
/** API-037. BR-062 — trailing clearance band, never live; suppressed below `min_comparable`. */
export async function getPositionCard(sellerCounterpartyId, listingLineId) {
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
    const rank = comparableLines.findIndex((l) => l._id.toString() === listingLineId) + 1;
    const lowPaise = comparableLines[0].ratePaise;
    const highPaise = comparableLines[comparableLines.length - 1].ratePaise;
    const gapBand = rank === 1 ? 'ahead' : rank <= Math.ceil(comparableLines.length / 2) ? 'competitive' : 'behind';
    return {
        rank,
        ofCount: comparableLines.length,
        gapBand,
        band: { lowPaise, highPaise, listingCount: comparableLines.length },
        suppressed: false,
    };
}
/** API-038. Never a name, never a rate — counts only. */
export async function getBoardOpportunities() {
    const lines = await ListingLine.find({});
    const listings = await Listing.find({ state: 'live' });
    const listingSellerById = new Map(listings.map((l) => [
        l._id.toString(),
        l.sellerId.toString(),
    ]));
    const groups = new Map();
    for (const line of lines) {
        const sellerId = listingSellerById.get(line.listingId.toString());
        if (!sellerId)
            continue;
        const key = `${line.skuId.toString()}|${buildConditionSetKey(line)}`;
        const set = groups.get(key) ?? new Set();
        set.add(sellerId);
        groups.set(key, set);
    }
    return [...groups.entries()].map(([key, sellers]) => {
        const [skuId, conditionSetKey] = key.split('|');
        return { skuId, conditionSetKey, sellerCount: sellers.size };
    });
}
