import { Types } from 'mongoose';
import { Product } from '../../models/Product.js';
import { Sku } from '../../models/Sku.js';
import { Listing } from '../../models/Listing.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Ask } from '../../models/Ask.js';
import { Pile } from '../../models/Pile.js';
import { Pool } from '../../models/Pool.js';
import { So } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { AppError } from '../../shared/errors.js';
/**
 * 29 Oct — soft delete of a product from Manage → Products (BR-370). The row stays, so past
 * orders, invoices and reports keep its name; `deletedAt` (and `active: false`, which the reads
 * that only check `active` rely on) takes it out of every list and picker. Its packs are left as
 * they are — every read reaches them through the product.
 */
/** An order in one of these is done; any other state still needs the product. */
const FINISHED_SO_STATES = ['delivered', 'closed', 'cancelled', 'supply_failed'];
/** What still points at this product; all zero means it can go. */
export async function productInUse(productId) {
    const skuIds = (await Sku.find({ productId }, { _id: 1 })).map((s) => s._id);
    const listings = await Listing.find({ productId, deletedAt: null }, { _id: 1, state: 1, sellerId: 1 });
    // 30 Oct — only a live listing holds it: a paused one is off every board, and cannot go live
    // again once the product is inactive or deleted (`relistListing`).
    const live = listings.filter((l) => l.state === 'live');
    const sellers = live.length
        ? await Seller.find({ _id: { $in: live.map((l) => l.sellerId) } }, { counterpartyId: 1 })
        : [];
    const firms = sellers.length
        ? await Counterparty.find({ _id: { $in: sellers.map((s) => s.counterpartyId) } }, { firm: 1 })
        : [];
    const liveListingSellers = [
        ...new Set(firms.map((f) => f.firm).filter((f) => Boolean(f))),
    ].sort();
    const lineIds = listings.length
        ? (await ListingLine.find({ listingId: { $in: listings.map((l) => l._id) } }, { _id: 1 })).map((l) => l._id)
        : [];
    const soIds = skuIds.length ? await SoLine.distinct('soId', { skuId: { $in: skuIds } }) : [];
    const [openAsks, pilesWaiting, openPools, unfinishedOrders] = await Promise.all([
        Ask.countDocuments({
            state: { $in: ['open', 'quoted'] },
            $or: [{ productId }, { skuId: { $in: skuIds } }],
        }),
        lineIds.length ? Pile.countDocuments({ decision: null, listingLineId: { $in: lineIds } }) : 0,
        skuIds.length ? Pool.countDocuments({ isActive: true, skuId: { $in: skuIds } }) : 0,
        soIds.length
            ? So.countDocuments({ _id: { $in: soIds }, state: { $nin: FINISHED_SO_STATES } })
            : 0,
    ]);
    return {
        liveListings: live.length,
        liveListingSellers,
        openAsks,
        pilesWaiting,
        openPools,
        unfinishedOrders,
    };
}
function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}
function describeInUse(u) {
    return [
        u.liveListings
            ? plural(u.liveListings, 'live listing', 'live listings') +
                (u.liveListingSellers.length ? ` (${u.liveListingSellers.join(', ')})` : '')
            : null,
        u.openAsks ? plural(u.openAsks, 'open ask', 'open asks') : null,
        u.pilesWaiting
            ? plural(u.pilesWaiting, 'request waiting on a seller', 'requests waiting on a seller')
            : null,
        u.openPools ? plural(u.openPools, 'open pool', 'open pools') : null,
        u.unfinishedOrders
            ? plural(u.unfinishedOrders, 'order not yet finished', 'orders not yet finished')
            : null,
    ].filter((s) => s !== null);
}
function asObjectId(id) {
    if (!Types.ObjectId.isValid(id)) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    }
    return new Types.ObjectId(id);
}
/** Refused while anything live points at it (`PRODUCT_IN_USE`, with what in `meta.inUse`). */
export async function deleteProduct(productId, employeeId) {
    const product = await Product.findOne({ _id: asObjectId(productId), deletedAt: null });
    if (!product)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    const inUse = await productInUse(product._id);
    const reasons = describeInUse(inUse);
    if (reasons.length > 0) {
        throw new AppError({
            code: 'PRODUCT_IN_USE',
            messageEn: `${product.brand} is still in use: ${reasons.join(', ')}. Ask the seller to pause a live listing, and let the rest finish, then delete it.`,
            meta: { inUse, reasons },
        });
    }
    product.deletedAt = new Date();
    product.deletedBy = new Types.ObjectId(employeeId);
    product.active = false;
    await product.save();
    return { productId };
}
/** Back in every list, but inactive — Admin looks it over and ticks Active to sell it again. */
export async function restoreProduct(productId) {
    const product = await Product.findOne({
        _id: asObjectId(productId),
        deletedAt: { $ne: null },
    });
    if (!product)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Deleted product not found.' });
    product.deletedAt = null;
    product.deletedBy = null;
    product.active = false;
    await product.save();
    return { productId };
}
