import { Enquiry } from '../../models/Enquiry.js';
import { Ask } from '../../models/Ask.js';
import { Quote } from '../../models/Quote.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Pile } from '../../models/Pile.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { So } from '../../models/So.js';
import { Chain } from '../../models/Chain.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Employee } from '../../models/Employee.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../shared/errors.js';
import { getChainView } from '../chain/chain.service.js';
import { projectChainView } from '../chain/chain.view.js';
import { computeBuyerFacingRatePaise } from '../listing/listing.service.js';
import { tradeStatusOf, } from './enquiry.status.js';
/** The desk an audience writes notes, owners and follow-ups as. Logistics has none. */
export function enquiryDeskOf(audience) {
    return audience === 'logistics' ? null : audience;
}
const idStr = (id) => String(id);
async function productLabels(refs) {
    const skuIds = [...new Set(refs.filter((r) => r.skuId).map((r) => idStr(r.skuId)))];
    const skus = skuIds.length ? await Sku.find({ _id: { $in: skuIds } }) : [];
    const skuById = new Map(skus.map((s) => [idStr(s._id), s]));
    const productIds = new Set(refs.filter((r) => r.productId).map((r) => idStr(r.productId)));
    for (const sku of skus)
        productIds.add(idStr(sku.productId));
    const products = productIds.size ? await Product.find({ _id: { $in: [...productIds] } }) : [];
    const brandById = new Map(products.map((p) => [idStr(p._id), p.brand]));
    return (ref) => {
        const sku = ref.skuId ? skuById.get(idStr(ref.skuId)) : undefined;
        const productId = sku ? idStr(sku.productId) : ref.productId ? idStr(ref.productId) : null;
        if (!productId)
            return null;
        return {
            productId,
            brand: brandById.get(productId) ?? '—',
            packLabel: sku?.packLabel ?? null,
        };
    };
}
async function partiesOf(model, ids) {
    const unique = [...new Set(ids.filter(Boolean).map(idStr))];
    if (unique.length === 0)
        return new Map();
    const docs = await model.find({ _id: { $in: unique } });
    const counterparties = await Counterparty.find({
        _id: { $in: docs.map((d) => d.counterpartyId) },
    });
    const firmByCp = new Map(counterparties.map((c) => [idStr(c._id), c.firm ?? null]));
    return new Map(docs.map((d) => [
        idStr(d._id),
        {
            id: idStr(d._id),
            counterpartyId: idStr(d.counterpartyId),
            firm: firmByCp.get(idStr(d.counterpartyId)) ?? null,
        },
    ]));
}
async function employeeNames(ids) {
    const unique = [...new Set(ids.filter(Boolean).map(idStr))];
    if (unique.length === 0)
        return new Map();
    const employees = await Employee.find({ _id: { $in: unique } }, { person: 1 });
    return new Map(employees.map((e) => [idStr(e._id), e.person]));
}
/** The seller behind each pile-request enquiry — Purchase's side, and the full view's. */
async function sellersForRequests(requestIds) {
    const out = new Map();
    if (requestIds.length === 0)
        return out;
    const requests = await PileRequest.find({ _id: { $in: requestIds } }, { pileId: 1 });
    const piles = await Pile.find({ _id: { $in: requests.map((r) => r.pileId) } });
    const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
    const listings = await Listing.find({ _id: { $in: lines.map((l) => l.listingId) } });
    const sellers = await partiesOf(Seller, listings.map((l) => l.sellerId));
    const pileById = new Map(piles.map((p) => [idStr(p._id), p]));
    const lineById = new Map(lines.map((l) => [idStr(l._id), l]));
    const listingById = new Map(listings.map((l) => [idStr(l._id), l]));
    for (const request of requests) {
        const pile = pileById.get(idStr(request.pileId));
        const line = pile ? lineById.get(idStr(pile.listingLineId)) : undefined;
        const listing = line ? listingById.get(idStr(line.listingId)) : undefined;
        const seller = listing ? sellers.get(idStr(listing.sellerId)) : undefined;
        if (seller)
            out.set(idStr(request._id), seller);
    }
    return out;
}
/** An enquiry's orders: by `so.enquiryId`, or — for orders raised before it existed — by its ask/pile request. */
function ordersFilter(enquiry) {
    const or = [{ enquiryId: enquiry._id }];
    if (enquiry.askId)
        or.push({ askId: enquiry.askId });
    if (enquiry.pileRequestId)
        or.push({ pileRequestId: enquiry.pileRequestId });
    return { $or: or };
}
function projectHeader(audience, enquiry, joins) {
    const owner = (id) => id ? { employeeId: idStr(id), name: joins.names.get(idStr(id)) ?? '—' } : null;
    const trade = enquiry.status === 'ordered' ? tradeStatusOf(joins.soStates) : null;
    const party = (enquiry.party ?? 'buyer');
    const common = {
        id: idStr(enquiry._id),
        enquiryNo: enquiry.enquiryNo,
        kind: enquiry.kind,
        party,
        channel: enquiry.channel,
        raisedAt: enquiry.raisedAt,
        qty: enquiry.qty,
        product: joins.product,
        productText: enquiry.productText ?? null,
        status: enquiry.status,
        phase: enquiry.phase,
        outcome: enquiry.outcome,
        waitingOn: enquiry.waitingOn ?? null,
        statusChangedAt: enquiry.statusChangedAt,
        ...(trade ?? {}),
        orderCount: joins.soStates.length,
        ...(joins.quoteCount !== null ? { quoteCount: joins.quoteCount } : {}),
        owners: { sales: owner(enquiry.owners?.sales), purchase: owner(enquiry.owners?.purchase) },
    };
    const followUp = enquiry.followUp ?? { sales: null, purchase: null };
    const rawProspect = enquiry.prospect
        ? {
            firm: enquiry.prospect.firm,
            contactName: enquiry.prospect.contactName ?? null,
            mobile: enquiry.prospect.mobile ?? null,
            place: enquiry.prospect.place ?? null,
        }
        : null;
    // A prospect is one side's own unregistered lead — a buyer prospect is
    // Sales's identity data, a seller prospect Purchase's (BR-060's wall,
    // applied the same way `buyer`/`seller` already are).
    const prospectForSales = party === 'buyer' ? rawProspect : null;
    const prospectForPurchase = party === 'seller' ? rawProspect : null;
    if (audience === 'full') {
        return {
            ...common,
            followUp: { sales: followUp.sales ?? null, purchase: followUp.purchase ?? null },
            buyer: joins.buyer,
            prospect: rawProspect,
            seller: joins.seller,
        };
    }
    if (audience === 'sales') {
        return {
            ...common,
            followUp: { sales: followUp.sales ?? null },
            buyer: joins.buyer,
            prospect: prospectForSales,
        };
    }
    if (audience === 'purchase') {
        return {
            ...common,
            followUp: { purchase: followUp.purchase ?? null },
            seller: joins.seller,
            prospect: prospectForPurchase,
        };
    }
    return common;
}
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `API-210` — newest first, filtered, each row projected for the caller's desk. */
export async function listEnquiries(audience, employeeId, query, now = new Date()) {
    const desk = enquiryDeskOf(audience);
    const and = [];
    if (query.kind)
        and.push({ kind: query.kind });
    if (query.outcome)
        and.push({ outcome: query.outcome });
    if (query.status)
        and.push({ status: query.status });
    if (query.q)
        and.push({ enquiryNo: { $regex: escapeRegex(query.q.trim()), $options: 'i' } });
    if (query.mine && desk) {
        and.push(desk === 'full'
            ? { $or: [{ 'owners.sales': employeeId }, { 'owners.purchase': employeeId }] }
            : { [`owners.${desk}`]: employeeId });
    }
    if (query.followUpDue && desk) {
        and.push(desk === 'full'
            ? { $or: [{ 'followUp.sales': { $lte: now } }, { 'followUp.purchase': { $lte: now } }] }
            : { [`followUp.${desk}`]: { $lte: now } });
    }
    const enquiries = await Enquiry.find(and.length ? { $and: and } : {})
        .sort({ raisedAt: -1 })
        .limit(query.limit ?? 50);
    const labelOf = await productLabels(enquiries.map((e) => ({ skuId: e.skuId, productId: e.productId })));
    const seesBuyer = audience === 'full' || audience === 'sales';
    const seesSeller = audience === 'full' || audience === 'purchase';
    const buyers = seesBuyer
        ? await partiesOf(Buyer, enquiries.map((e) => e.buyerId))
        : new Map();
    const sellers = seesSeller
        ? await sellersForRequests(enquiries.map((e) => e.pileRequestId).filter(Boolean))
        : new Map();
    // A pre-trade seller-party enquiry names its seller directly (no pile behind it yet).
    const directSellers = seesSeller
        ? await partiesOf(Seller, enquiries.map((e) => e.sellerId))
        : new Map();
    const names = await employeeNames(enquiries.flatMap((e) => [e.owners?.sales, e.owners?.purchase]));
    const sos = enquiries.length
        ? await So.find({ $or: enquiries.flatMap((e) => ordersFilter(e).$or) }, { enquiryId: 1, askId: 1, pileRequestId: 1, state: 1 })
        : [];
    const statesFor = (enquiry) => sos
        .filter((so) => idStr(so.enquiryId) === idStr(enquiry._id) ||
        (enquiry.askId && idStr(so.askId) === idStr(enquiry.askId)) ||
        (enquiry.pileRequestId && idStr(so.pileRequestId) === idStr(enquiry.pileRequestId)))
        .map((so) => so.state);
    const askIds = enquiries.filter((e) => e.askId).map((e) => e.askId);
    const quoteCounts = new Map(askIds.length
        ? (await Quote.aggregate([
            { $match: { askId: { $in: askIds } } },
            { $group: { _id: '$askId', n: { $sum: 1 } } },
        ])).map((g) => [idStr(g._id), g.n])
        : []);
    return enquiries.map((enquiry) => projectHeader(audience, enquiry, {
        product: labelOf({ skuId: enquiry.skuId, productId: enquiry.productId }),
        buyer: enquiry.buyerId ? (buyers.get(idStr(enquiry.buyerId)) ?? null) : null,
        seller: enquiry.pileRequestId
            ? (sellers.get(idStr(enquiry.pileRequestId)) ?? null)
            : enquiry.sellerId
                ? (directSellers.get(idStr(enquiry.sellerId)) ?? null)
                : null,
        names,
        soStates: statesFor(enquiry),
        quoteCount: enquiry.kind === 'ask' ? (quoteCounts.get(idStr(enquiry.askId)) ?? 0) : null,
    }));
}
/**
 * What the caller may do from this screen right now. Each action maps to an
 * endpoint behind its own permission, which is re-checked there; this list
 * only stops the screen offering a button that would be refused.
 */
function actionsFor(permissions, audience, enquiry, soStates) {
    const actions = [];
    const buyerCall = permissions.includes(PERMISSIONS.PROXY_BUYER_CALL);
    const sellerCall = permissions.includes(PERMISSIONS.PROXY_SELLER_CALL);
    const status = enquiry.status;
    if (buyerCall && enquiry.kind === 'ask') {
        if (status === 'quotes_received')
            actions.push('accept_fill');
        if (enquiry.phase === 'raised' || enquiry.phase === 'responded')
            actions.push('walk_away');
    }
    if (sellerCall && enquiry.kind === 'pile_request' && status === 'awaiting_seller') {
        actions.push('confirm_pile', 'requote_pile', 'decline_pile');
    }
    if (buyerCall && soStates.includes('promotion_offered'))
        actions.push('promotion_decision');
    if (status === 'pre_trade') {
        const party = (enquiry.party ?? 'buyer');
        if (party === 'buyer' && buyerCall)
            actions.push('convert_to_ask', 'drop', 'edit');
        if (party === 'seller' && sellerCall)
            actions.push('mark_listed', 'drop', 'edit');
    }
    if (permissions.includes(PERMISSIONS.ENQUIRY_MANAGE) && enquiryDeskOf(audience)) {
        actions.push('manage');
    }
    return actions;
}
const proxyEntries = (log) => (log ?? []).map((entry) => ({
    at: entry.at,
    source: 'enquiry',
    type: `staff_call:${entry.action}`,
    callNote: entry.callNote,
}));
const byTime = (a, b) => a.at.getTime() - b.at.getTime();
async function linkedChains(audience, sos) {
    const out = [];
    for (const so of sos) {
        const raw = await getChainView(idStr(so.chainId));
        const chain = await Chain.findById(so.chainId, { source: 1 });
        out.push({
            chainId: idStr(so.chainId),
            soId: idStr(so._id),
            source: chain?.source ?? 'inquiry',
            view: projectChainView(audience, raw),
            chainNo: raw.chainNo,
            events: raw.events.map((e) => ({ type: e.type, at: e.at })),
            soProxyLog: so.proxyLog,
        });
    }
    return out;
}
function chainsFor(audience, chains) {
    return chains.map((c) => ({
        chainId: c.chainId,
        // Logistics already gets no SO id from the chain view; keep it that way.
        ...(audience === 'logistics' ? {} : { soId: c.soId }),
        source: c.source,
        view: c.view,
    }));
}
function chainTimeline(audience, chains) {
    return chains.flatMap((c) => [
        ...c.events.map((e) => ({
            at: e.at,
            source: 'chain',
            type: e.type,
            chainNo: c.chainNo,
        })),
        // The SO's call notes were written by Sales (accept-fill, promotion) — buyer side.
        ...(audience === 'full' || audience === 'sales'
            ? proxyEntries(c.soProxyLog).map((e) => ({ ...e, chainNo: c.chainNo }))
            : []),
    ]);
}
/** `API-211`. */
export async function getEnquiry(audience, permissions, enquiryId) {
    const enquiry = await Enquiry.findById(enquiryId).catch(() => null);
    if (!enquiry)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Enquiry not found.' });
    const sos = await So.find(ordersFilter(enquiry)).sort({ createdAt: 1 });
    const soStates = sos.map((so) => so.state);
    const chains = await linkedChains(audience, sos);
    const seesBuyer = audience === 'full' || audience === 'sales';
    const seesSeller = audience === 'full' || audience === 'purchase';
    const labelOf = await productLabels([{ skuId: enquiry.skuId, productId: enquiry.productId }]);
    const buyer = seesBuyer && enquiry.buyerId
        ? ((await partiesOf(Buyer, [enquiry.buyerId])).get(idStr(enquiry.buyerId)) ?? null)
        : null;
    const seller = seesSeller && enquiry.pileRequestId
        ? ((await sellersForRequests([enquiry.pileRequestId])).get(idStr(enquiry.pileRequestId)) ??
            null)
        : seesSeller && enquiry.sellerId
            ? ((await partiesOf(Seller, [enquiry.sellerId])).get(idStr(enquiry.sellerId)) ?? null)
            : null;
    const noteAuthors = (enquiry.notes ?? []).map((n) => n.authorId);
    const names = await employeeNames([
        enquiry.owners?.sales,
        enquiry.owners?.purchase,
        enquiry.raisedBy,
        ...noteAuthors,
    ]);
    const trade = enquiry.kind === 'ask' && enquiry.askId
        ? await askPart(audience, enquiry.askId, enquiry.buyerId)
        : enquiry.kind === 'pile_request' && enquiry.pileRequestId
            ? await pilePart(audience, enquiry.pileRequestId)
            : { fields: {}, timeline: [], quoteCount: null };
    // Desk-scoped notes: a desk reads its own; the full view reads all.
    const desk = enquiryDeskOf(audience);
    const notes = (enquiry.notes ?? [])
        .filter((n) => desk === 'full' || (desk !== null && n.desk === desk))
        .map((n) => ({
        desk: n.desk,
        author: names.get(idStr(n.authorId)) ?? '—',
        text: n.text,
        at: n.at,
    }));
    const timeline = [
        { at: enquiry.raisedAt, source: 'enquiry', type: `enquiry_raised:${enquiry.channel}` },
        ...(enquiry.status === 'dropped' && enquiry.closedAt
            ? [{ at: enquiry.closedAt, source: 'enquiry', type: 'enquiry_dropped' }]
            : []),
        ...(enquiry.status === 'listed' && enquiry.closedAt
            ? [{ at: enquiry.closedAt, source: 'enquiry', type: 'enquiry_listed' }]
            : []),
        ...trade.timeline,
        ...chainTimeline(audience, chains),
    ].sort(byTime);
    return {
        ...projectHeader(audience, enquiry, {
            product: labelOf({ skuId: enquiry.skuId, productId: enquiry.productId }),
            buyer,
            seller,
            names,
            soStates,
            quoteCount: trade.quoteCount,
        }),
        raisedBy: enquiry.raisedBy ? (names.get(idStr(enquiry.raisedBy)) ?? '—') : null,
        requirement: enquiry.requirement
            ? {
                expiryBand: enquiry.requirement.expiryBand ?? null,
                deliveryBand: enquiry.requirement.deliveryBand ?? null,
            }
            : null,
        dropReason: enquiry.dropReason ?? null,
        closedAt: enquiry.closedAt ?? null,
        ...trade.fields,
        chains: chainsFor(audience, chains),
        timeline,
        ...(desk ? { notes } : {}),
        actions: actionsFor(permissions, audience, enquiry, soStates),
    };
}
async function askPart(audience, askId, buyerId) {
    const ask = await Ask.findById(askId);
    if (!ask)
        return { fields: {}, timeline: [], quoteCount: 0 };
    const quotes = await Quote.find({ askId: ask._id }).sort({ ratePaiseForIndore: 1 });
    const sellers = audience === 'full' || audience === 'purchase'
        ? await partiesOf(Seller, quotes.map((q) => q.sellerId))
        : new Map();
    // BR-060 — the buyer-side rate is the buyer's own tier rate, computed fresh,
    // exactly as listMyAsks shows it; an "any pack" ask has no SKU to price yet.
    const buyerDoc = audience === 'full' || audience === 'sales' ? await Buyer.findById(buyerId) : null;
    const buyerRate = async (sellerNet) => buyerDoc && ask.skuId ? computeBuyerFacingRatePaise(buyerDoc, ask.skuId, sellerNet) : null;
    const quoteViews = await Promise.all(quotes.map(async (q) => {
        const common = {
            quoteId: idStr(q._id),
            qtyAvailable: q.qtyAvailable,
            daysToIndore: q.daysToIndore,
            status: q.status,
            gapCodes: q.gapCodes ?? [],
            expiryBand: q.conditionSet?.expiryBand,
            deliveryBand: q.conditionSet?.deliveryBand,
        };
        if (audience === 'logistics')
            return common;
        // A losing seller only ever learns a rank (BR-063); desks see it the same way.
        const ranked = q.rank !== null && q.rank !== undefined ? { rank: q.rank, ofCount: q.ofCount } : {};
        const conditions = {
            expiryExact: q.conditionSet?.expiryExact,
            provenance: q.conditionSet?.provenance,
            bindingUntil: q.bindingUntil,
        };
        if (audience === 'sales') {
            return {
                ...common,
                ...ranked,
                ...conditions,
                buyerRatePaise: await buyerRate(q.ratePaiseForIndore),
            };
        }
        const sellerSide = {
            seller: sellers.get(idStr(q.sellerId)) ?? null,
            ratePaiseForIndore: q.ratePaiseForIndore,
        };
        if (audience === 'purchase')
            return { ...common, ...ranked, ...conditions, ...sellerSide };
        return {
            ...common,
            ...ranked,
            ...conditions,
            ...sellerSide,
            buyerRatePaise: await buyerRate(q.ratePaiseForIndore),
        };
    }));
    return {
        quoteCount: quotes.length,
        fields: {
            askId: idStr(ask._id),
            allPacks: ask.allPacks,
            visibleToAllAt: ask.visibleToAllAt,
            holdExpiresAt: ask.holdExpiresAt ?? null,
            ttlAt: ask.ttlAt,
            quotes: quoteViews,
        },
        timeline: [
            { at: ask.createdAt, source: 'enquiry', type: 'ask_raised', qty: ask.qty },
            ...(ask.headStartOpenedAt && ask.headStartOpenedAt.getTime() - ask.createdAt.getTime() > 1000
                ? [{ at: ask.headStartOpenedAt, source: 'enquiry', type: 'opened_to_all_sellers' }]
                : []),
            ...quotes.map((q) => ({
                at: q.createdAt,
                source: 'enquiry',
                type: 'quote_received',
                qty: q.qtyAvailable,
            })),
            ...(ask.state === 'withdrawn' || ask.state === 'lapsed'
                ? [{ at: ask.updatedAt, source: 'enquiry', type: `ask_${ask.state}` }]
                : []),
            // The ask's call notes are Sales's (raise, convert, accept, walk away) — buyer side.
            ...(audience === 'full' || audience === 'sales' ? proxyEntries(ask.proxyLog) : []),
        ],
    };
}
async function pilePart(audience, pileRequestId) {
    const request = await PileRequest.findById(pileRequestId);
    const pile = request ? await Pile.findById(request.pileId) : null;
    const line = pile ? await ListingLine.findById(pile.listingLineId) : null;
    if (!request || !pile || !line)
        return { fields: {}, timeline: [], quoteCount: null };
    const allRequests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
    // WF-05 — the pile as the seller sees it: index, boxes and time only. No
    // identity on any request, whoever is reading. `isThis` marks this enquiry's.
    const pileView = {
        pileId: idStr(pile._id),
        decision: pile.decision ?? null,
        decidedAt: pile.decidedAt ?? null,
        confirmWindowEndsAt: pile.confirmWindowEndsAt,
        askedQty: allRequests.reduce((sum, r) => sum + r.qty, 0),
        confirmedQty: pile.confirmedQty ?? null,
        shortfall: pile.shortfall,
        executedAt: pile.executedAt ?? null,
        sellerLockedUntil: pile.sellerLockedUntil ?? null,
        requestCount: allRequests.length,
        requests: allRequests.map((r, index) => ({
            index: index + 1,
            boxes: r.qty,
            time: r.requestedAt,
            isThis: idStr(r._id) === idStr(request._id),
        })),
    };
    // The listed line: the seller's own rate is Purchase's side; Sales sees
    // only what this buyer is charged for it (BR-060).
    const lineCommon = {
        lineId: idStr(line._id),
        expiryBand: line.expiryBand,
        deliveryBand: line.deliveryBand,
        provenance: line.provenance,
        moqExact: line.moqExact,
    };
    const buyerDoc = audience === 'full' || audience === 'sales' ? await Buyer.findById(request.buyerId) : null;
    const buyerRatePaise = buyerDoc
        ? await computeBuyerFacingRatePaise(buyerDoc, line.skuId, line.ratePaise)
        : null;
    const lineView = audience === 'logistics'
        ? lineCommon
        : audience === 'sales'
            ? { ...lineCommon, buyerRatePaise }
            : audience === 'purchase'
                ? { ...lineCommon, ratePaise: line.ratePaise, qtyLeft: line.qty }
                : { ...lineCommon, ratePaise: line.ratePaise, qtyLeft: line.qty, buyerRatePaise };
    return {
        quoteCount: null,
        fields: { pileRequestId: idStr(request._id), pile: pileView, line: lineView },
        timeline: [
            {
                at: request.requestedAt,
                source: 'enquiry',
                type: 'rate_taken',
                qty: request.qty,
            },
            ...(pile.decision && pile.decidedAt
                ? [
                    {
                        at: pile.decidedAt,
                        source: 'enquiry',
                        type: `seller_${pile.decision}`,
                        ...(pile.decision === 'confirmed' && pile.confirmedQty !== null
                            ? { qty: pile.confirmedQty ?? undefined }
                            : {}),
                    },
                ]
                : []),
            ...(pile.executedAt
                ? [
                    {
                        at: pile.executedAt,
                        source: 'enquiry',
                        type: pile.shortfall ? 'shortfall_to_desk' : 'orders_raised',
                    },
                ]
                : []),
            // The pile's call notes are Purchase's (confirm/requote/decline) — seller side.
            ...(audience === 'full' || audience === 'purchase' ? proxyEntries(pile.proxyLog) : []),
        ],
    };
}
