/**
 * An ask names its product in one of two ways, never both:
 *   - a pack-specific ask stores `skuId` and leaves `productId` null;
 *   - an "all packs" ask stores `productId` and leaves `skuId` null.
 * The buyer app and the staff-proxy route both write exactly this shape (they call the
 * same `raiseAsk`), so any desk read that asks "which asks are on this product?" must match
 * on both fields. Filtering on `productId` alone silently drops every pack-specific ask.
 *
 * `skuIds` is every SKU of `productId`.
 */
export function asksOnProductFilter(productId, skuIds) {
    return { $or: [{ productId }, { skuId: { $in: skuIds } }] };
}
/** The same, for a seller's whole catalogue (many products at once). */
export function asksOnProductsFilter(productIds, skuIds) {
    return { $or: [{ productId: { $in: productIds } }, { skuId: { $in: skuIds } }] };
}
