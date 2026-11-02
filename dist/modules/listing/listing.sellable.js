import { Product } from '../../models/Product.js';
/**
 * 30 Oct — an inactive or deleted product is not sold (BR-370): its live listings drop off every
 * board, offer list and Buy screen, but the listings themselves are left as they are, so ticking
 * Active again brings them straight back. Work already under way (a request waiting on a seller,
 * a pool, an order) carries on. Its own file so the Sales board can use it without importing
 * the listing service.
 */
export async function unsellableProductIds() {
    return Product.find({ $or: [{ active: false }, { deletedAt: { $ne: null } }] }, { _id: 1 }).then((rows) => rows.map((r) => r._id));
}
/** True when the listing's product may be sold right now. */
export async function isProductSellable(productId) {
    return Boolean(await Product.exists({ _id: productId, active: true, deletedAt: null }));
}
