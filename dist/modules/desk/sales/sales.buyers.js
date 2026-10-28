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
import { computeBuyerFacingRatePaise } from '../../listing/listing.service.js';
import { addDays } from '../../../shared/clock.js';
import { ASK_LEAK_STALENESS_HOURS, BILLED_SO_STATES, DELIVERED_SO_STATES, DISPATCHED_SO_STATES, FUNNEL_LABELS, PAID_SO_STATES, PAYMENT_PENDING_SO_STATES, } from './sales.funnel.js';
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
// Phase 3 (DEC-058) — the category, or for a buyer not yet migrated the old
// position/trader flag; blank when he was never classified.
function categoryOf(buyer) {
    if (buyer.category)
        return buyer.category;
    if (buyer.isTrader)
        return 'Trader';
    return buyer.tradePosition ? capitalizeTradePosition(buyer.tradePosition) : null;
}
/** Everything, as before (the top-bar search uses this). */
export async function listBuyers(filters) {
    return (await listBuyersPage(filters)).items;
}
/**
 * 29 Oct — one page of the Buyers list (`offset`/`limit`), with the total and
 * the filter options for the whole tab (every district and assignee in it,
 * not only those on this page). Without `limit`, the whole list.
 */
export async function listBuyersPage(filters, page = {}) {
    const assignments = await BookAssignment.find({});
    const ownerEmployeeIdByBuyer = new Map(assignments.map((a) => [a.buyerId.toString(), a.ownerEmployeeId]));
    const buyerQuery = {};
    if (filters.category)
        buyerQuery.category = filters.category;
    if (filters.districtId) {
        const inDistrict = await Tehsil.find({ districtId: filters.districtId }, { _id: 1 });
        buyerQuery.tehsilId = { $in: inDistrict.map((t) => t._id) };
    }
    let buyers = await Buyer.find(buyerQuery).sort({ createdAt: -1 });
    if (filters.assignedTo === 'queue') {
        buyers = buyers.filter((b) => !ownerEmployeeIdByBuyer.has(b._id.toString()));
    }
    else if (filters.assignedTo) {
        buyers = buyers.filter((b) => ownerEmployeeIdByBuyer.get(b._id.toString())?.toString() ===
            filters.assignedTo);
    }
    if (filters.tab === 'book') {
        buyers = buyers.filter((b) => ownerEmployeeIdByBuyer.has(b._id.toString()));
    }
    else if (filters.tab === 'queue') {
        buyers = buyers.filter((b) => !ownerEmployeeIdByBuyer.has(b._id.toString()));
    }
    const facets = await facetsFor(filters.tab, ownerEmployeeIdByBuyer);
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
                cp?.pan?.toLowerCase().includes(q) ||
                cp?.ownerName?.toLowerCase().includes(q) ||
                cp?.mobile?.toLowerCase().includes(q) ||
                cp?.contactMobile?.toLowerCase().includes(q) ||
                inTehsil);
        });
    }
    const total = buyers.length;
    if (page.limit) {
        const offset = page.offset ?? 0;
        buyers = buyers.slice(offset, offset + page.limit);
    }
    const tehsilIds = [
        ...new Set(buyers.filter((b) => b.tehsilId).map((b) => b.tehsilId.toString())),
    ];
    const tehsils = await Tehsil.find({ _id: { $in: tehsilIds } });
    const tehsilNameById = new Map(tehsils.map((t) => [t._id.toString(), t.name]));
    const districtByTehsilId = new Map(tehsils.map((t) => [t._id.toString(), t.district]));
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
    const items = buyers.map((b) => {
        const idStr = b._id.toString();
        const cp = counterpartyById.get(b.counterpartyId.toString());
        const ownerEmployeeId = ownerEmployeeIdByBuyer.get(idStr);
        const stats = orderStatsByBuyer.get(idStr);
        return {
            buyerId: idStr,
            firm: cp?.firm ?? '',
            gstin: cp?.gstin ?? null,
            pan: cp?.pan ?? null,
            contactName: cp?.ownerName ?? null,
            mobile: cp?.contactMobile ?? cp?.mobile ?? null,
            tehsil: b.tehsilId
                ? (tehsilNameById.get(b.tehsilId.toString()) ?? null)
                : null,
            district: b.tehsilId
                ? (districtByTehsilId.get(b.tehsilId.toString()) ?? null)
                : null,
            tier: categoryOf(b),
            assignedToEmployeeId: ownerEmployeeId ? ownerEmployeeId.toString() : null,
            orderCount: stats?.count ?? 0,
            lastOrderAt: stats?.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
            rateViews: b.rateViews,
            ownerName: ownerEmployeeId
                ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null)
                : null,
        };
    });
    return { items, total, facets };
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
    // An ask moves on as it is worked: `open` (waiting on a rate) is "He asked"; once a rate is
    // given it is `quoted` and lives under "Rate given"; once he confirms it is an order.
    const liveAsks = await Ask.find({
        buyerId: buyer._id,
        state: { $in: ['open', 'quoted'] },
    }).sort({
        createdAt: -1,
    });
    // Quotes raised on his asks that Sales has not yet given him — the ask is still "He asked" for
    // those, even once another quote has been given and it also shows under "Rate given".
    const parkedQuotes = liveAsks.length
        ? await Quote.find({
            askId: { $in: liveAsks.map((a) => a._id) },
            status: 'pending_sales',
        }).sort({ createdAt: 1 })
        : [];
    const parkedByAskId = new Map();
    for (const quote of parkedQuotes) {
        const key = quote.askId.toString();
        parkedByAskId.set(key, [...(parkedByAskId.get(key) ?? []), quote]);
    }
    // "He asked" is an ask still waiting on a rate. The moment any rate is given it moves to
    // "Rate given"; quotes parked on it show on its row for as long as it is waiting.
    const openAsks = liveAsks.filter((a) => a.state === 'open');
    // An ask names a product, or only a pack (SKU) — resolve either to the product so
    // "He asked" can show a name, never a bare id.
    const askSkus = await Sku.find({
        _id: { $in: liveAsks.filter((a) => a.skuId).map((a) => a.skuId) },
    });
    const askSkuById = new Map(askSkus.map((s) => [s._id.toString(), s]));
    const askProductIdOf = (a) => a.productId
        ? a.productId.toString()
        : a.skuId
            ? (askSkuById.get(a.skuId.toString())?.productId?.toString() ?? null)
            : null;
    const askProducts = await Product.find({
        _id: { $in: [...new Set(liveAsks.map(askProductIdOf).filter((id) => !!id))] },
    });
    const askProductById = new Map(askProducts.map((p) => [p._id.toString(), p]));
    const [callLogs, orders, liveQuotes] = await Promise.all([
        listCallLogsForBuyer(buyerId),
        listOrders({ buyerId }),
        Quote.find({ askId: { $in: liveAsks.map((a) => a._id) }, status: 'live' }).sort({
            bindingUntil: 1,
        }),
    ]);
    const liveQuoteCount = liveQuotes.length;
    const askById = new Map(liveAsks.map((a) => [a._id.toString(), a]));
    // The pack a quote names (a product-level ask has none of its own), and his rate on it: the
    // seller's net plus the margin-matrix cell for his tier — the same figure he is shown.
    const quoteSkuIds = [...liveQuotes, ...parkedQuotes]
        .map((q) => q.skuId)
        .filter((id) => !!id);
    const quoteSkus = quoteSkuIds.length ? await Sku.find({ _id: { $in: quoteSkuIds } }) : [];
    const quoteSkuById = new Map(quoteSkus.map((s) => [s._id.toString(), s]));
    const skuOfQuote = (q) => {
        const ask = askById.get(q.askId.toString());
        const skuId = q.skuId ?? ask?.skuId;
        return skuId
            ? (quoteSkuById.get(skuId.toString()) ?? askSkuById.get(skuId.toString()))
            : undefined;
    };
    const buyerRateOf = async (q) => {
        const ask = askById.get(q.askId.toString());
        const skuId = q.skuId ?? ask?.skuId;
        return skuId ? computeBuyerFacingRatePaise(buyer, skuId, q.ratePaiseForIndore) : null;
    };
    const liveQuoteRows = await Promise.all(liveQuotes.map(async (q) => {
        const ask = askById.get(q.askId.toString());
        const productId = ask ? askProductIdOf(ask) : null;
        return {
            quoteId: q._id.toString(),
            askId: q.askId.toString(),
            productId,
            brand: (productId ? askProductById.get(productId)?.brand : undefined) ?? '—',
            packLabel: skuOfQuote(q)?.packLabel ?? null,
            ratePaise: await buyerRateOf(q),
            qtyAvailable: q.qtyAvailable,
            askQty: ask?.qty ?? q.qtyAvailable,
            daysToIndore: q.daysToIndore,
            givenAt: q.createdAt.toISOString(),
            bindingUntil: q.bindingUntil.toISOString(),
        };
    }));
    const parkedRowsByAskId = new Map();
    for (const q of parkedQuotes) {
        const row = {
            quoteId: q._id.toString(),
            askId: q.askId.toString(),
            listingLineId: q.listingLineId ? q.listingLineId.toString() : null,
            packLabel: skuOfQuote(q)?.packLabel ?? null,
            ratePaise: await buyerRateOf(q),
            qtyAvailable: q.qtyAvailable,
            daysToIndore: q.daysToIndore,
            expiryBand: q.conditionSet?.expiryBand ?? '',
            expiryExact: q.conditionSet?.expiryExact ?? '',
            deliveryBand: q.conditionSet?.deliveryBand ?? '',
            raisedAt: q.createdAt.toISOString(),
        };
        parkedRowsByAskId.set(row.askId, [...(parkedRowsByAskId.get(row.askId) ?? []), row]);
    }
    // The same nine joints as the Funnel tab, with the same state lists and wording,
    // counted over this buyer's own records only.
    const staleBefore = addDays(new Date(), -(ASK_LEAK_STALENESS_HOURS / 24));
    // An ask with a quote already waiting on Sales is not stale — the wait is on this desk.
    const askLeakCount = openAsks.filter((a) => a.state === 'open' &&
        !parkedByAskId.has(a._id.toString()) &&
        a.createdAt <= staleBefore).length;
    const countOrders = (states) => orders.filter((o) => states.includes(o.state)).length;
    const pendingCount = countOrders(PAYMENT_PENDING_SO_STATES);
    const paidCount = countOrders(PAID_SO_STATES);
    const billedCount = countOrders(BILLED_SO_STATES);
    const dispatchedCount = countOrders(DISPATCHED_SO_STATES);
    const deliveredCount = countOrders(DELIVERED_SO_STATES);
    // Same state lists as the three counts above, so each section's size is its joint's count.
    const inStates = (states) => orders.filter((o) => states.includes(o.state));
    const ordersByStage = {
        paymentPending: inStates(PAYMENT_PENDING_SO_STATES),
        paid: inStates(PAID_SO_STATES),
        billed: inStates(BILLED_SO_STATES),
        dispatched: inStates(DISPATCHED_SO_STATES),
        delivered: inStates(DELIVERED_SO_STATES),
        other: orders.filter((o) => ![
            ...PAYMENT_PENDING_SO_STATES,
            ...PAID_SO_STATES,
            ...BILLED_SO_STATES,
            ...DISPATCHED_SO_STATES,
            ...DELIVERED_SO_STATES,
        ].includes(o.state)),
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
        stage('billed', billedCount > 0, billedCount),
        stage('dispatched', dispatchedCount > 0, dispatchedCount),
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
        mobile: counterparty?.contactMobile ?? counterparty?.mobile ?? '',
        tehsil: tehsil?.name ?? null,
        tier: categoryOf(buyer),
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
                askedAt: a.createdAt.toISOString(),
                expectedRatePaise: a.expectedRatePaise ?? null,
                pendingQuotes: parkedRowsByAskId.get(a._id.toString()) ?? [],
            };
        }),
        liveQuotes: liveQuoteRows,
        callLogs,
        orders,
        ordersByStage,
    };
}
/**
 * The filter options for a tab, over every buyer in it — districts by id and
 * name, and the people buyers are assigned to — so a filter can pick a value
 * that is not on the page loaded so far.
 */
async function facetsFor(tab, ownerEmployeeIdByBuyer) {
    const inTab = (await Buyer.find({}, { tehsilId: 1 })).filter((b) => {
        const owned = ownerEmployeeIdByBuyer.has(b._id.toString());
        return tab === 'book' ? owned : tab === 'queue' ? !owned : true;
    });
    const tehsils = await Tehsil.find({ _id: { $in: inTab.map((b) => b.tehsilId).filter(Boolean) }, districtId: { $ne: null } }, { districtId: 1, district: 1 });
    const districts = new Map();
    for (const t of tehsils)
        districts.set(String(t.districtId), t.district ?? '');
    const ownerIds = tab === 'queue'
        ? []
        : [
            ...new Set(inTab
                .map((b) => ownerEmployeeIdByBuyer.get(b._id.toString()))
                .filter(Boolean)
                .map(String)),
        ];
    const people = await Employee.find({ _id: { $in: ownerIds } }, { person: 1 });
    return {
        districts: [...districts]
            .map(([districtId, name]) => ({ districtId, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        assignees: people
            .map((e) => ({ employeeId: String(e._id), person: e.person }))
            .sort((a, b) => a.person.localeCompare(b.person)),
    };
}
