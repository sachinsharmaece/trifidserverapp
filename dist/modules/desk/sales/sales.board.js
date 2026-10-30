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
import { computeBuyerFacingRatePaise, listPricedLinesVisibleToBuyerDoc, } from '../../listing/listing.service.js';
import { asksOnProductFilter } from '../../demand/askScope.js';
import { isProductSellable, unsellableProductIds } from '../../listing/listing.sellable.js';
const DEFAULT_TIER = 'Retailer';
/**
 * BR-060 — Sales never reads a listing line's own `ratePaise` (the seller's
 * net) directly; every rate shown here goes through the same buyer-facing
 * pricing function the buyer feed itself uses. Sales is not always acting
 * for one real buyer, so a bare tier name is turned into the minimal
 * buyer-shaped object `computeBuyerFacingRatePaise` actually reads
 * (`isTrader`/`tradePosition` — see `chain.service.ts`'s `toRateTier`),
 * rather than reimplementing the margin lookup for a "no buyer" case.
 */
function buyerShapedForTier(tier) {
    // Phase 3 — the category is the tier (DEC-058).
    return { category: tier, isTrader: false, tradePosition: null };
}
async function rateForTierOrBuyer(skuId, sellerNetPaise, opts) {
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
    return computeBuyerFacingRatePaise(buyerShapedForTier(opts.tier ?? DEFAULT_TIER), skuId, sellerNetPaise);
}
/** GET /staff/sales/board — every product with at least one live listing line. */
export async function getBoardProducts() {
    // 30 Oct — an inactive or deleted product is not on the board (BR-370).
    const liveListings = await Listing.find({
        state: 'live',
        productId: { $nin: await unsellableProductIds() },
    });
    const liveListingIds = liveListings.map((l) => l._id);
    const productIdByListingId = new Map(liveListings.map((l) => [
        l._id.toString(),
        l.productId.toString(),
    ]));
    const lines = await ListingLine.find({ listingId: { $in: liveListingIds }, qty: { $gt: 0 } });
    const linesByProduct = new Map();
    for (const line of lines) {
        const productId = productIdByListingId.get(line.listingId.toString());
        if (!productId)
            continue;
        const group = linesByProduct.get(productId) ?? [];
        group.push(line);
        linesByProduct.set(productId, group);
    }
    if (linesByProduct.size === 0)
        return [];
    const productIds = [...linesByProduct.keys()];
    const products = await Product.find({ _id: { $in: productIds } });
    const manufacturers = await Manufacturer.find({
        _id: { $in: products.map((p) => p.manufacturerId) },
    });
    const manufacturerNameById = new Map(manufacturers.map((m) => [m._id.toString(), m.name]));
    // Order count as a cheap proxy for reach — via so_line's own skuId, not an exact live count (spec allows an approximation here).
    const allSoLines = await SoLine.find({}).select('soId skuId');
    const skus = await Sku.find({ productId: { $in: productIds } });
    const skuIdsByProduct = new Map();
    for (const sku of skus) {
        const productId = sku.productId.toString();
        const set = skuIdsByProduct.get(productId) ?? new Set();
        set.add(sku._id.toString());
        skuIdsByProduct.set(productId, set);
    }
    const soIdToBuyerId = new Map((await So.find({}).select('buyerId')).map((so) => [
        so._id.toString(),
        so.buyerId.toString(),
    ]));
    const rows = [];
    for (const [productId, productLines] of linesByProduct) {
        const product = products.find((p) => p._id.toString() === productId);
        if (!product)
            continue;
        const skuIds = skuIdsByProduct.get(productId) ?? new Set();
        const buyerIds = new Set();
        for (const soLine of allSoLines) {
            if (!skuIds.has(soLine.skuId.toString()))
                continue;
            const buyerId = soIdToBuyerId.get(soLine.soId.toString());
            if (buyerId)
                buyerIds.add(buyerId);
        }
        let cheapestRatePaise = null;
        for (const line of productLines) {
            const rate = await rateForTierOrBuyer(line.skuId, line.ratePaise, {});
            if (rate === null)
                continue;
            if (cheapestRatePaise === null || rate < cheapestRatePaise)
                cheapestRatePaise = rate;
        }
        rows.push({
            productId,
            brand: product.brand,
            technicalName: product.technical,
            manufacturerName: manufacturerNameById.get(product.manufacturerId.toString()) ?? '',
            ladderCount: productLines.length,
            cheapestRatePaise,
            buyerCount: buyerIds.size,
        });
    }
    return rows;
}
/**
 * GET /staff/sales/buyers/:buyerId/board — client item 16: "On the board for him" is
 * everything available for him to buy, which is what reaches his tehsil. It is never his
 * order history, so a buyer with no orders sees the same board as one with a hundred.
 */
export async function getBoardForBuyer(buyerDocId) {
    const priced = await listPricedLinesVisibleToBuyerDoc(buyerDocId);
    if (priced.length === 0)
        return [];
    const productIds = [
        ...new Set(priced.map((p) => p.listing.productId.toString())),
    ];
    const products = await Product.find({ _id: { $in: productIds } });
    const manufacturers = await Manufacturer.find({
        _id: { $in: products.map((p) => p.manufacturerId) },
    });
    const manufacturerNameById = new Map(manufacturers.map((m) => [m._id.toString(), m.name]));
    const skus = await Sku.find({ _id: { $in: priced.map((p) => p.line.skuId) } });
    const packLabelBySkuId = new Map(skus.map((s) => [s._id.toString(), s.packLabel]));
    const rows = [];
    for (const product of products) {
        const productId = product._id.toString();
        const ladder = priced
            .filter((p) => p.listing.productId.toString() === productId)
            .map((p) => ({
            listingLineId: p.line._id.toString(),
            skuId: p.line.skuId.toString(),
            packLabel: packLabelBySkuId.get(p.line.skuId.toString()) ?? '',
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
            manufacturerName: manufacturerNameById.get(product.manufacturerId.toString()) ?? '',
            ladder,
        });
    }
    return rows.sort((a, b) => a.ladder[0].ratePaise - b.ladder[0].ratePaise);
}
/** GET /staff/sales/board/:productId — the full rate ladder for one product. */
export async function getBoardProduct(productId, opts) {
    const product = await Product.findById(productId);
    if (!product)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    const manufacturer = await Manufacturer.findById(product.manufacturerId);
    const skus = await Sku.find({ productId: product._id });
    const skuIds = skus.map((s) => s._id);
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    // 30 Oct — nothing on the ladder while the product is inactive or deleted (BR-370).
    const liveListings = (await isProductSellable(product._id))
        ? await Listing.find({ productId: product._id, state: 'live' })
        : [];
    const listingIds = liveListings.map((l) => l._id);
    const lines = await ListingLine.find({
        listingId: { $in: listingIds },
        skuId: { $in: skuIds },
        qty: { $gt: 0 },
    });
    const ladder = [];
    for (const line of lines) {
        const listing = liveListings.find((l) => l._id.toString() === line.listingId.toString());
        const sku = skuById.get(line.skuId.toString());
        const ratePaise = await rateForTierOrBuyer(line.skuId, line.ratePaise, opts);
        ladder.push({
            listingLineId: line._id.toString(),
            skuId: line.skuId.toString(),
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
        ...asksOnProductFilter(product._id, skuIds),
        state: { $nin: ['lapsed', 'withdrawn'] },
    }).sort({ createdAt: -1 });
    // B-27 — the demand table showed a raw truncated buyer id as the only
    // identifier, never the firm.
    const askBuyers = await Buyer.find({ _id: { $in: openAsks.map((a) => a.buyerId) } });
    const askBuyerCounterparties = await Counterparty.find({
        _id: { $in: askBuyers.map((b) => b.counterpartyId) },
    });
    const askFirmByCounterpartyId = new Map(askBuyerCounterparties.map((c) => [c._id.toString(), c.firm ?? '']));
    const askFirmByBuyerId = new Map(askBuyers.map((b) => [
        b._id.toString(),
        askFirmByCounterpartyId.get(b.counterpartyId.toString()) ?? '',
    ]));
    const detail = {
        productId: product._id.toString(),
        brand: product.brand,
        technicalName: product.technical,
        manufacturerName: manufacturer?.name ?? '',
        ladder,
        openAsks: openAsks.map((a) => ({
            askId: a._id.toString(),
            buyerId: a.buyerId.toString(),
            buyerFirm: askFirmByBuyerId.get(a.buyerId.toString()) ?? '',
            skuId: a.skuId ? a.skuId.toString() : null,
            qty: a.qty,
            state: a.state,
            createdAt: a.createdAt.toISOString(),
        })),
    };
    if (opts.buyerId) {
        const soLines = await SoLine.find({ skuId: { $in: skuIds } });
        const soIds = soLines.map((l) => l.soId);
        const sos = await So.find({ _id: { $in: soIds }, buyerId: opts.buyerId }).sort({
            createdAt: -1,
        });
        detail.buyerHistory = sos.map((so) => ({
            soId: so._id.toString(),
            soNo: so.soNo,
            state: so.state,
            totalPaise: so.totalPaise,
            createdAt: so.createdAt.toISOString(),
        }));
    }
    return detail;
}
