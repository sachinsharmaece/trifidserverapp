import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Tehsil } from '../../../models/Tehsil.js';
import { BookAssignment } from '../../../models/BookAssignment.js';
import { Employee } from '../../../models/Employee.js';
import { So } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { AppError } from '../../../shared/errors.js';
import { addDays } from '../../../shared/clock.js';
import { ASK_LEAK_STALENESS_HOURS, DELIVERED_SO_STATES, FUNNEL_LABELS, PAID_SO_STATES, PAYMENT_PENDING_SO_STATES, } from './sales.funnel.js';
import { listCallLogsForBuyer } from './sales.calls.js';
import { listOrders } from './sales.orders.js';
// B-52 — `tradePosition` is stored lowercase (the enum); `rateTier` (the
// pricing-side computation in chain.service.ts#toRateTier) already
// capitalizes it for that reason, but this desk re-derives the same "tier"
// label inline without doing so, showing e.g. "retailer" next to "Trader".
// Not reusing `toRateTier` outright: it defaults an unclassified buyer to
// Retailer for pricing (BR-044), but this screen means to show blank for
// "not yet classified" — a real, separate signal for staff, not lost here.
function capitalizeTradePosition(tradePosition) {
    return tradePosition.charAt(0).toUpperCase() + tradePosition.slice(1);
}
/** GET /staff/sales/buyers?q=&tab=book|queue */
export async function listBuyers(filters) {
    const assignments = await BookAssignment.find({});
    const ownerEmployeeIdByBuyer = new Map(assignments.map((a) => [a.buyerId.toString(), a.ownerEmployeeId]));
    let buyers = await Buyer.find({}).sort({ createdAt: -1 });
    if (filters.tab === 'book') {
        buyers = buyers.filter((b) => ownerEmployeeIdByBuyer.has(b._id.toString()));
    }
    else if (filters.tab === 'queue') {
        buyers = buyers.filter((b) => !ownerEmployeeIdByBuyer.has(b._id.toString()));
    }
    const counterparties = await Counterparty.find({
        _id: { $in: buyers.map((b) => b.counterpartyId) },
    });
    const counterpartyById = new Map(counterparties.map((c) => [c._id.toString(), c]));
    if (filters.q) {
        const q = filters.q.toLowerCase();
        const matchingTehsils = await Tehsil.find({ name: { $regex: filters.q, $options: 'i' } });
        const matchingTehsilIds = new Set(matchingTehsils.map((t) => t._id.toString()));
        buyers = buyers.filter((b) => {
            const cp = counterpartyById.get(b.counterpartyId.toString());
            const inTehsil = Boolean(b.tehsilId) && matchingTehsilIds.has(b.tehsilId.toString());
            return Boolean(cp?.firm?.toLowerCase().includes(q) ||
                cp?.gstin?.toLowerCase().includes(q) ||
                cp?.ownerName?.toLowerCase().includes(q) ||
                cp?.mobile?.toLowerCase().includes(q) ||
                inTehsil);
        });
    }
    const tehsilIds = [
        ...new Set(buyers.filter((b) => b.tehsilId).map((b) => b.tehsilId.toString())),
    ];
    const tehsils = await Tehsil.find({ _id: { $in: tehsilIds } });
    const tehsilNameById = new Map(tehsils.map((t) => [t._id.toString(), t.name]));
    const employees = await Employee.find({ _id: { $in: [...ownerEmployeeIdByBuyer.values()] } });
    const employeeNameById = new Map(employees.map((e) => [e._id.toString(), e.person]));
    const sos = await So.find({ buyerId: { $in: buyers.map((b) => b._id) } })
        .select('buyerId createdAt')
        .sort({ createdAt: -1 });
    const orderStatsByBuyer = new Map();
    for (const so of sos) {
        const key = so.buyerId.toString();
        const createdAt = so.createdAt;
        const existing = orderStatsByBuyer.get(key);
        if (existing)
            existing.count += 1;
        else
            orderStatsByBuyer.set(key, { count: 1, lastOrderAt: createdAt }); // sorted desc — the first hit is the latest.
    }
    return buyers.map((b) => {
        const idStr = b._id.toString();
        const cp = counterpartyById.get(b.counterpartyId.toString());
        const ownerEmployeeId = ownerEmployeeIdByBuyer.get(idStr);
        const stats = orderStatsByBuyer.get(idStr);
        return {
            buyerId: idStr,
            firm: cp?.firm ?? '',
            gstin: cp?.gstin ?? null,
            contactName: cp?.ownerName ?? null,
            mobile: cp?.mobile ?? null,
            tehsil: b.tehsilId
                ? (tehsilNameById.get(b.tehsilId.toString()) ?? null)
                : null,
            tier: b.isTrader
                ? 'Trader'
                : b.tradePosition
                    ? capitalizeTradePosition(b.tradePosition)
                    : null,
            orderCount: stats?.count ?? 0,
            lastOrderAt: stats?.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
            rateViews: b.rateViews,
            ownerName: ownerEmployeeId
                ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null)
                : null,
        };
    });
}
/** GET /staff/sales/buyers/:buyerId — the buyer-file drill-down. */
export async function getBuyerFile(buyerId) {
    const buyer = await Buyer.findById(buyerId);
    if (!buyer)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
    const counterparty = await Counterparty.findById(buyer.counterpartyId);
    const tehsil = buyer.tehsilId ? await Tehsil.findById(buyer.tehsilId) : null;
    const assignment = await BookAssignment.findOne({ buyerId: buyer._id });
    const owner = assignment ? await Employee.findById(assignment.ownerEmployeeId) : null;
    const sos = await So.find({ buyerId: buyer._id });
    const lines = await SoLine.find({ soId: { $in: sos.map((s) => s._id) } });
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const soById = new Map(sos.map((s) => [s._id.toString(), s]));
    const orderCountByProduct = new Map();
    const lastPaidByProduct = new Map();
    for (const line of lines) {
        const sku = skuById.get(line.skuId.toString());
        if (!sku)
            continue;
        const productId = sku.productId.toString();
        orderCountByProduct.set(productId, (orderCountByProduct.get(productId) ?? 0) + 1);
        const so = soById.get(line.soId.toString());
        const at = so ? so.createdAt : null;
        if (at) {
            const current = lastPaidByProduct.get(productId);
            if (!current || at > current.at) {
                lastPaidByProduct.set(productId, { ratePaise: line.ratePaise, at });
            }
        }
    }
    const productHistory = [...orderCountByProduct.entries()].map(([productId, orderCount]) => ({
        productId,
        brand: productById.get(productId)?.brand ?? '',
        orderCount,
        lastPaidRatePaise: lastPaidByProduct.get(productId)?.ratePaise ?? null,
    }));
    const openAsks = await Ask.find({
        buyerId: buyer._id,
        state: { $nin: ['lapsed', 'withdrawn'] },
    }).sort({
        createdAt: -1,
    });
    // An ask names a product, or only a pack (SKU) — resolve either to the product so
    // "He asked" can show a name, never a bare id.
    const askSkus = await Sku.find({
        _id: { $in: openAsks.filter((a) => a.skuId).map((a) => a.skuId) },
    });
    const askSkuById = new Map(askSkus.map((s) => [s._id.toString(), s]));
    const askProductIdOf = (a) => a.productId
        ? a.productId.toString()
        : a.skuId
            ? (askSkuById.get(a.skuId.toString())?.productId?.toString() ?? null)
            : null;
    const askProducts = await Product.find({
        _id: { $in: [...new Set(openAsks.map(askProductIdOf).filter((id) => !!id))] },
    });
    const askProductById = new Map(askProducts.map((p) => [p._id.toString(), p]));
    const [callLogs, orders, liveQuotes] = await Promise.all([
        listCallLogsForBuyer(buyerId),
        listOrders({ buyerId }),
        Quote.find({ askId: { $in: openAsks.map((a) => a._id) }, status: 'live' }).sort({
            bindingUntil: 1,
        }),
    ]);
    const liveQuoteCount = liveQuotes.length;
    const askById = new Map(openAsks.map((a) => [a._id.toString(), a]));
    const liveQuoteRows = liveQuotes.map((q) => {
        const ask = askById.get(q.askId.toString());
        const productId = ask ? askProductIdOf(ask) : null;
        const sku = ask?.skuId ? askSkuById.get(ask.skuId.toString()) : undefined;
        return {
            quoteId: q._id.toString(),
            askId: q.askId.toString(),
            productId,
            brand: (productId ? askProductById.get(productId)?.brand : undefined) ?? '—',
            packLabel: sku?.packLabel ?? null,
            ratePaiseForIndore: q.ratePaiseForIndore,
            qtyAvailable: q.qtyAvailable,
            daysToIndore: q.daysToIndore,
            bindingUntil: q.bindingUntil.toISOString(),
        };
    });
    // The same nine joints as the Funnel tab, with the same state lists and wording,
    // counted over this buyer's own records only.
    const staleBefore = addDays(new Date(), -(ASK_LEAK_STALENESS_HOURS / 24));
    const askLeakCount = openAsks.filter((a) => a.state === 'open' && a.createdAt <= staleBefore).length;
    const countOrders = (states) => orders.filter((o) => states.includes(o.state)).length;
    const pendingCount = countOrders(PAYMENT_PENDING_SO_STATES);
    const paidCount = countOrders(PAID_SO_STATES);
    const deliveredCount = countOrders(DELIVERED_SO_STATES);
    // Same state lists as the three counts above, so each section's size is its joint's count.
    const inStates = (states) => orders.filter((o) => states.includes(o.state));
    const ordersByStage = {
        paymentPending: inStates(PAYMENT_PENDING_SO_STATES),
        paid: inStates(PAID_SO_STATES),
        delivered: inStates(DELIVERED_SO_STATES),
        other: orders.filter((o) => ![...PAYMENT_PENDING_SO_STATES, ...PAID_SO_STATES, ...DELIVERED_SO_STATES].includes(o.state)),
    };
    const stage = (key, reached, count, extra = {}) => ({ key, label: FUNNEL_LABELS[key], reached, count, ...extra });
    const funnel = [
        stage('registered', true, null), // This desk only lists buyers who are already approved.
        stage('classified', buyer.classified, null),
        stage('viewing', buyer.rateViews > 0, buyer.rateViews),
        stage('asked', openAsks.length > 0, openAsks.length, { leakCount: askLeakCount }),
        stage('rate_held', liveQuoteCount > 0, liveQuoteCount),
        stage('took_it', pendingCount > 0, pendingCount),
        stage('paid', paidCount > 0, paidCount),
        stage('delivered', deliveredCount > 0, deliveredCount),
        stage('ordered_again', sos.length > 1, null),
    ];
    return {
        buyerId: buyer._id.toString(),
        // BR-088-adjacent — `buyerId` here is the Buyer document, not the
        // Counterparty; the proxy endpoints (`requireActiveBuyer`) key on
        // `Buyer.counterpartyId`, so callers that hand this DTO's id straight to
        // a proxy action get a guaranteed "Buyers only." — this is the correct
        // id for that (same field EnterListingPage.tsx already uses on the
        // seller side).
        counterpartyId: buyer.counterpartyId.toString(),
        firm: counterparty?.firm ?? '',
        gstin: counterparty?.gstin ?? null,
        mobile: counterparty?.mobile ?? '',
        tehsil: tehsil?.name ?? null,
        tier: buyer.isTrader
            ? 'Trader'
            : buyer.tradePosition
                ? capitalizeTradePosition(buyer.tradePosition)
                : null,
        classified: buyer.classified,
        rateViews: buyer.rateViews,
        ownerName: owner?.person ?? null,
        funnel,
        productHistory,
        openAsks: openAsks.map((a) => {
            const productId = askProductIdOf(a);
            const product = productId ? askProductById.get(productId) : undefined;
            const sku = a.skuId ? askSkuById.get(a.skuId.toString()) : undefined;
            return {
                askId: a._id.toString(),
                productId,
                skuId: a.skuId ? a.skuId.toString() : null,
                qty: a.qty,
                state: a.state,
                brand: product?.brand ?? '—',
                technical: product?.technical ?? '—',
                packLabel: sku?.packLabel ?? null,
            };
        }),
        liveQuotes: liveQuoteRows,
        callLogs,
        orders,
        ordersByStage,
    };
}
