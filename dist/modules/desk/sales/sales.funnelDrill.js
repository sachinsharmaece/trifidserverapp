import { Ask } from '../../../models/Ask.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Product } from '../../../models/Product.js';
import { Quote } from '../../../models/Quote.js';
import { Sku } from '../../../models/Sku.js';
import { addDays } from '../../../shared/clock.js';
/**
 * The records behind the Sales funnel's "Asked" and "Rate held" counts — the
 * same filters `sales.funnel.ts` counts with, listed instead of counted, so
 * the number on the Funnel and the rows behind it can never disagree.
 */
// Kept in step with `ASK_LEAK_STALENESS_HOURS` in sales.funnel.ts (not exported there).
const ASK_LEAK_STALENESS_HOURS = 26;
/** Product, pack and buyer-firm names for a batch of asks, resolved in a few queries. */
async function describeAsks(asks) {
    const skuIds = asks.filter((a) => a.skuId).map((a) => a.skuId);
    const skus = skuIds.length ? await Sku.find({ _id: { $in: skuIds } }) : [];
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const productIdOf = (a) => a.productId
        ? a.productId.toString()
        : a.skuId
            ? (skuById.get(a.skuId.toString())?.productId?.toString() ?? null)
            : null;
    const productIds = [...new Set(asks.map(productIdOf).filter((id) => !!id))];
    const products = productIds.length ? await Product.find({ _id: { $in: productIds } }) : [];
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const buyers = await Buyer.find({ _id: { $in: asks.map((a) => a.buyerId) } });
    const counterparties = buyers.length
        ? await Counterparty.find({ _id: { $in: buyers.map((b) => b.counterpartyId) } })
        : [];
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '']));
    const firmByBuyerId = new Map(buyers.map((b) => [
        b._id.toString(),
        firmByCounterpartyId.get(b.counterpartyId.toString()) ?? '',
    ]));
    return (a) => {
        const productId = productIdOf(a);
        const product = productId ? productById.get(productId) : undefined;
        const sku = a.skuId ? skuById.get(a.skuId.toString()) : undefined;
        const buyerId = a.buyerId.toString();
        return {
            buyerId,
            buyerFirm: firmByBuyerId.get(buyerId) ?? '',
            productId,
            brand: product?.brand ?? '—',
            technical: product?.technical ?? '—',
            packLabel: sku?.packLabel ?? null,
        };
    };
}
/** GET /staff/sales/funnel/asked — the asks counted under "Asked", oldest first. */
export async function listFunnelAsks(now = new Date()) {
    const asks = await Ask.find({ state: { $nin: ['lapsed', 'withdrawn'] } }).sort({ createdAt: 1 });
    const describe = await describeAsks(asks);
    const staleBefore = addDays(now, -(ASK_LEAK_STALENESS_HOURS / 24));
    return asks.map((a) => {
        const createdAt = a.createdAt;
        return {
            askId: a._id.toString(),
            ...describe(a),
            qty: a.qty,
            state: a.state,
            createdAt: createdAt.toISOString(),
            pastSla: a.state === 'open' && createdAt <= staleBefore,
        };
    });
}
/** GET /staff/sales/funnel/rate-held — the live quotes counted under "Rate held", soonest to lapse first. */
export async function listFunnelHeldRates() {
    const quotes = await Quote.find({ status: 'live' }).sort({ bindingUntil: 1 });
    const asks = quotes.length ? await Ask.find({ _id: { $in: quotes.map((q) => q.askId) } }) : [];
    const askById = new Map(asks.map((a) => [a._id.toString(), a]));
    const describe = await describeAsks(asks);
    const rows = [];
    for (const q of quotes) {
        const ask = askById.get(q.askId.toString());
        if (!ask)
            continue; // A live quote whose ask is gone has no buyer to show.
        rows.push({
            quoteId: q._id.toString(),
            askId: ask._id.toString(),
            ...describe(ask),
            qty: ask.qty,
            heldUntil: q.bindingUntil.toISOString(),
        });
    }
    return rows;
}
