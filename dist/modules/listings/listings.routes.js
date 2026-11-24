import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { numberSetting } from '../../db/settings.js';
import { ListingModel, ProductModel, SellerModel, SkuModel, } from '../../models/index.js';
import { MAX_COL_PAISE, MAX_RATE_PAISE } from '../../models/listing.model.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { EXPIRY_BANDS, LISTING_STATUSES, PROVENANCES } from '../../shared/enums.js';
import { HttpError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { objectId, pagingShape } from '../parties/common.js';
import { canUseListings } from '../parties/permissions.js';
import { expireOldListings } from './expire.js';
import { dedupeKeyOf, dropExceeds, dropInBp, landedRate } from './rates.js';
/** Listings: what a seller offers to sell, and at what rate. Purchase and the supervisors only (see permissions.ts). */
export const listingsRouter = Router();
// Same values as the seeded settings (LISTING_LIFE_DAYS, RATE_DECREASE_CONFIRM_BP), used if a setting is missing.
const DEFAULT_LISTING_LIFE_DAYS = 45;
const DEFAULT_RATE_DECREASE_BP = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const ratePaise = z.number().int('Use a whole number of paise.').min(1).max(MAX_RATE_PAISE);
const shared = {
    sellerId: objectId,
    skuId: objectId,
    expiryBand: z.enum(EXPIRY_BANDS),
    moqBoxes: z.number().int().min(1).max(10_000),
    quantityBoxes: z.number().int().min(1).max(1_000_000),
    provenance: z.enum(PROVENANCES),
    /** Only needed when the new rate is lower than the allowed drop (the preview says so). */
    confirmDecrease: z.boolean().optional(),
};
/** FOR: one landed rate per unit. EX: the Ex rate per unit plus the carriage cost (COL) of one box. */
const offerBody = z.discriminatedUnion('rateType', [
    z.object({ ...shared, rateType: z.literal('FOR'), ratePaisePerUnit: ratePaise }),
    z.object({
        ...shared,
        rateType: z.literal('EX'),
        exRatePaisePerUnit: ratePaise,
        colPaisePerBox: z.number().int().min(0).max(MAX_COL_PAISE),
    }),
]);
const listParams = z.object({
    ...pagingShape,
    status: z.enum(LISTING_STATUSES).optional(),
    sellerId: objectId.optional(),
    skuId: objectId.optional(),
});
/** A person may pause, resume or withdraw a listing. (EXPIRED is set by the clock, never by a person.) */
const patchBody = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'WITHDRAWN']) });
const rupees = (paise) => (paise / 100).toFixed(2);
/** The listing as the API sends it: names instead of ids, and the value of one box. */
async function toListings(listings) {
    const sellers = await SellerModel.find({ _id: { $in: listings.map((l) => l.sellerId) } });
    const skus = await SkuModel.find({ _id: { $in: listings.map((l) => l.skuId) } });
    const products = await ProductModel.find({ _id: { $in: skus.map((sku) => sku.productId) } });
    return listings.map((listing) => {
        const seller = sellers.find((s) => s.id === String(listing.sellerId));
        const sku = skus.find((s) => s.id === String(listing.skuId));
        const product = products.find((p) => sku && p.id === String(sku.productId));
        return {
            id: listing.id,
            seller: seller ? { id: seller.id, number: seller.number, firmName: seller.firmName } : null,
            sku: sku
                ? {
                    id: sku.id,
                    packLabel: sku.packLabel,
                    unitsPerBox: sku.unitsPerBox,
                    productName: product?.name ?? '',
                }
                : null,
            rateType: listing.rateType,
            ratePaisePerUnit: listing.ratePaisePerUnit,
            exRatePaisePerUnit: listing.exRatePaisePerUnit ?? null,
            colPaisePerBox: listing.colPaisePerBox ?? null,
            boxValuePaise: listing.ratePaisePerUnit * listing.unitsPerBoxSnapshot,
            expiryBand: listing.expiryBand,
            moqBoxes: listing.moqBoxes,
            quantityBoxes: listing.quantityBoxes,
            provenance: listing.provenance,
            status: listing.status,
            expiresAt: listing.expiresAt.toISOString(),
            createdAt: listing.get('createdAt').toISOString(),
        };
    });
}
async function findListing(id) {
    if (!isValidObjectId(id))
        throw notFound('Listing not found.');
    const listing = await ListingModel.findById(id);
    if (!listing)
        throw notFound('Listing not found.');
    return listing;
}
/** The two figures to compare when a rate drops. Ex is compared with Ex, so a change in COL alone is not a "drop". */
function comparedFigures(offer, landed, previous) {
    if (offer.rateType === 'EX' &&
        previous.rateType === 'EX' &&
        previous.exRatePaisePerUnit != null) {
        return { previous: previous.exRatePaisePerUnit, next: offer.exRatePaisePerUnit };
    }
    return { previous: previous.ratePaisePerUnit, next: landed };
}
/**
 * Everything both the preview and the save need to know about an offer: the landed rate, the value of a box,
 * whether the same offer is already live, and whether the rate dropped too far below this seller's last live rate.
 */
async function assessOffer(offer) {
    await expireOldListings();
    const seller = await SellerModel.findById(offer.sellerId);
    if (!seller?.active)
        throw badRequest('Choose an active seller.');
    const sku = await SkuModel.findById(offer.skuId);
    const product = sku ? await ProductModel.findById(sku.productId) : null;
    if (!sku?.active || !product?.active)
        throw badRequest('Choose an active product pack.');
    const landed = offer.rateType === 'EX'
        ? landedRate(offer.exRatePaisePerUnit, offer.colPaisePerBox, sku.unitsPerBox)
        : offer.ratePaisePerUnit;
    if (landed > MAX_RATE_PAISE)
        throw badRequest('This rate is too high. Check the amounts.');
    const dedupeKey = dedupeKeyOf({
        sellerId: seller.id,
        skuId: sku.id,
        rateType: offer.rateType,
        ratePaisePerUnit: landed,
        expiryBand: offer.expiryBand,
        moqBoxes: offer.moqBoxes,
        provenance: offer.provenance,
    });
    const duplicate = await ListingModel.exists({ dedupeKey, status: 'ACTIVE' });
    let decrease = null;
    const previous = await ListingModel.findOne({
        sellerId: seller._id,
        skuId: sku._id,
        status: 'ACTIVE',
    }).sort({ createdAt: -1, _id: -1 });
    if (previous) {
        const figures = comparedFigures(offer, landed, previous);
        const limitBp = await numberSetting('RATE_DECREASE_CONFIRM_BP', DEFAULT_RATE_DECREASE_BP);
        if (dropExceeds(figures.previous, figures.next, limitBp)) {
            decrease = {
                fromPaisePerUnit: figures.previous,
                toPaisePerUnit: figures.next,
                pctBp: dropInBp(figures.previous, figures.next),
            };
        }
    }
    return { seller, sku, landed, dedupeKey, duplicate: duplicate !== null, decrease };
}
listingsRouter.use('/listings', requireAuth, canUseListings);
/**
 * POST /listings/preview  (the same body as POST /listings)
 *   ->  { unitsPerBox, landedPaisePerUnit, boxValuePaise, lotValuePaise, duplicate, decrease }
 * Shows what saving would do, without saving. `lotValuePaise` is the value of the smallest order (MOQ boxes).
 * `decrease` is null, or { fromPaisePerUnit, toPaisePerUnit, pctBp } when the rate is lower than allowed
 * and saving will need `confirmDecrease: true`.
 */
listingsRouter.post('/listings/preview', async (req, res) => {
    const offer = offerBody.parse(req.body);
    const { sku, landed, duplicate, decrease } = await assessOffer(offer);
    const boxValuePaise = landed * sku.unitsPerBox;
    res.json({
        unitsPerBox: sku.unitsPerBox,
        landedPaisePerUnit: landed,
        boxValuePaise,
        lotValuePaise: boxValuePaise * offer.moqBoxes,
        duplicate,
        decrease,
    });
});
/**
 * GET /listings?q=&page=&pageSize=&status=&sellerId=&skuId=  ->  { listings, total, page, pageSize }
 * `q` matches the seller number or firm name, or the product name. Newest first.
 */
listingsRouter.get('/listings', async (req, res) => {
    const { q, page, pageSize, status, sellerId, skuId } = listParams.parse(req.query);
    await expireOldListings();
    let search = {};
    if (q) {
        const key = escapeRegex(normaliseKey(q));
        const sellers = await SellerModel.find({
            $or: [{ number: new RegExp(escapeRegex(q), 'i') }, { firmKey: { $regex: key } }],
        }).limit(100);
        const products = await ProductModel.find({ nameLower: { $regex: key } }).limit(100);
        const skus = await SkuModel.find({ productId: { $in: products.map((p) => p._id) } });
        search = {
            $or: [
                { sellerId: { $in: sellers.map((s) => s._id) } },
                { skuId: { $in: skus.map((s) => s._id) } },
            ],
        };
    }
    const filter = {
        ...search,
        ...(status ? { status } : {}),
        ...(sellerId ? { sellerId } : {}),
        ...(skuId ? { skuId } : {}),
    };
    const [total, listings] = await Promise.all([
        ListingModel.countDocuments(filter),
        ListingModel.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize),
    ]);
    res.json({ listings: await toListings(listings), total, page, pageSize });
});
/**
 * POST /listings  { sellerId, skuId, rateType: 'FOR', ratePaisePerUnit } or
 *                 { ..., rateType: 'EX', exRatePaisePerUnit, colPaisePerBox }, plus
 *                 { expiryBand, moqBoxes, quantityBoxes, provenance, confirmDecrease? }  ->  201 { listing }.
 * An identical live offer is refused (409 LISTING_EXISTS). A rate more than the allowed drop below the seller's last
 * live rate for this pack is refused (409 RATE_DECREASE_NEEDS_CONFIRMATION) unless `confirmDecrease` is true.
 * The listing lives LISTING_LIFE_DAYS days.
 */
listingsRouter.post('/listings', async (req, res) => {
    const offer = offerBody.parse(req.body);
    const { seller, sku, landed, dedupeKey, duplicate, decrease } = await assessOffer(offer);
    if (duplicate) {
        throw conflict('This seller already has an identical live offer for this pack.', 'LISTING_EXISTS');
    }
    if (decrease && !offer.confirmDecrease) {
        throw new HttpError(409, 'RATE_DECREASE_NEEDS_CONFIRMATION', `This rate is ${(decrease.pctBp / 100).toFixed(2)}% lower than this seller's last live rate ` +
            `(${rupees(decrease.fromPaisePerUnit)} to ${rupees(decrease.toPaisePerUnit)} per unit). Confirm to save it.`, decrease);
    }
    const user = currentUserOf(req);
    const now = new Date();
    const lifeDays = await numberSetting('LISTING_LIFE_DAYS', DEFAULT_LISTING_LIFE_DAYS);
    const listing = await ListingModel.create({
        sellerId: seller._id,
        skuId: sku._id,
        rateType: offer.rateType,
        ratePaisePerUnit: landed,
        ...(offer.rateType === 'EX'
            ? { exRatePaisePerUnit: offer.exRatePaisePerUnit, colPaisePerBox: offer.colPaisePerBox }
            : {}),
        unitsPerBoxSnapshot: sku.unitsPerBox,
        expiryBand: offer.expiryBand,
        moqBoxes: offer.moqBoxes,
        quantityBoxes: offer.quantityBoxes,
        provenance: offer.provenance,
        expiresAt: new Date(now.getTime() + lifeDays * DAY_MS),
        dedupeKey,
        ...(decrease
            ? {
                decreaseConfirmed: {
                    fromRatePaise: decrease.fromPaisePerUnit,
                    pctBp: decrease.pctBp,
                    by: user.id,
                    at: now,
                },
            }
            : {}),
        createdBy: user.id,
    }).catch(failIfDuplicate('This seller already has an identical live offer for this pack.', 'LISTING_EXISTS'));
    await writeAudit(req, {
        action: 'listing.create',
        entityType: 'Listing',
        entityId: listing.id,
        after: {
            sellerId: seller.id,
            skuId: sku.id,
            rateType: listing.rateType,
            ratePaisePerUnit: listing.ratePaisePerUnit,
            exRatePaisePerUnit: listing.exRatePaisePerUnit ?? null,
            colPaisePerBox: listing.colPaisePerBox ?? null,
            expiryBand: listing.expiryBand,
            moqBoxes: listing.moqBoxes,
            quantityBoxes: listing.quantityBoxes,
            provenance: listing.provenance,
            expiresAt: listing.expiresAt.toISOString(),
            decreaseConfirmedPctBp: decrease?.pctBp ?? null,
        },
    });
    const [created] = await toListings([listing]);
    res.status(201).json({ listing: created });
});
/**
 * PATCH /listings/:id  { status: 'PAUSED' | 'ACTIVE' | 'WITHDRAWN' }  ->  { listing }
 * Pause a live listing, resume a paused one, or withdraw it for good. The rate and details never change: to change
 * them, withdraw the listing and make a new one. Expired and withdrawn listings are closed (409 LISTING_CLOSED).
 */
listingsRouter.patch('/listings/:id', async (req, res) => {
    const { status } = patchBody.parse(req.body);
    await expireOldListings();
    const listing = await findListing(req.params.id);
    if (listing.status !== status) {
        if (listing.status === 'EXPIRED' || listing.status === 'WITHDRAWN') {
            throw conflict('An expired or withdrawn listing cannot be changed.', 'LISTING_CLOSED');
        }
        if (status === 'ACTIVE') {
            // Resuming: another identical live copy may have been made while this one was paused.
            const twin = await ListingModel.exists({
                dedupeKey: listing.dedupeKey,
                status: 'ACTIVE',
                _id: { $ne: listing._id },
            });
            if (twin) {
                throw conflict('This seller already has an identical live offer for this pack.', 'LISTING_EXISTS');
            }
        }
        const before = { status: listing.status };
        listing.set('status', status);
        await listing
            .save()
            .catch(failIfDuplicate('This seller already has an identical live offer for this pack.', 'LISTING_EXISTS'));
        const changes = onlyChanged(before, { status: listing.status });
        await writeAudit(req, {
            action: 'listing.update',
            entityType: 'Listing',
            entityId: listing.id,
            ...changes,
        });
    }
    const [updated] = await toListings([listing]);
    res.json({ listing: updated });
});
//# sourceMappingURL=listings.routes.js.map