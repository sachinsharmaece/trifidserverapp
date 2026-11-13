import { withTransaction } from '../../db/transaction.js';
import { Buyer } from '../../models/Buyer.js';
import { Listing } from '../../models/Listing.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Product } from '../../models/Product.js';
import { Seller } from '../../models/Seller.js';
import { Sku } from '../../models/Sku.js';
import { AppError } from '../../shared/errors.js';
import { addHours } from '../../shared/clock.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { writeAuditLog } from '../../shared/audit.js';
import { createSoInSession } from '../chain/chain.service.js';
import { computeBuyerFacingRatePaise } from '../listing/listing.service.js';
import { assertMarketplaceOpen } from '../marketplace/marketplace.guard.js';
import { counterpartyIdForBuyer, enqueueNotification, } from '../notification/notification.outbox.js';
/**
 * 2 Nov — BR-378. When the seller confirms a pile, each buyer on it is *given the deal* — his boxes,
 * the exact expiry, his own rate — and it is his to take (an order, with its own payment window) or
 * to walk away from, inside a 24-hour hold. Sales does the same on a call for a buyer who asks it to.
 * Until then the boxes are held off the listing; walking away, or the hold running out, puts them back.
 */
export const PILE_OFFER_HOLD_HOURS = 24;
/** One buyer's order off a pile: the SO for `boxes`, and his "order confirmed" message (WF-05 steps 5–8). */
export async function raiseOrderForRequest(ctx, request, boxes, session) {
    const created = await createSoInSession({
        buyerId: request.buyerId.toString(),
        sellerId: ctx.sellerId,
        skuId: ctx.skuId,
        boxes,
        sellerNetPaise: ctx.sellerNetPaise,
        placeOfSupply: 'intra_state', // Refined once M6's tax-jurisdiction lookup exists; see CHANGELOG.
        pileRequestId: request._id.toString(),
        ...(request.enquiryId ? { enquiryId: request.enquiryId.toString() } : {}),
        ...(ctx.overrideRatePaise !== undefined
            ? { overrideRatePaise: ctx.overrideRatePaise, overrideReasonCode: ctx.overrideReasonCode }
            : {}),
    }, ctx.actor, session);
    // CH §21.8 #3 — "Seller confirms supply." Queued AFTER createSoInSession's own `payment_due`
    // for this buyer, so where the weekly cap (BR-283) allows only one message it is the money
    // deadline that goes out, not this one — see QR-054.
    await enqueueNotification({
        counterpartyId: await counterpartyIdForBuyer(request.buyerId, session),
        templateKey: 'order_confirmed',
        params: { soNo: created.soNo },
        correlationId: ctx.actor.correlationId,
    }, session);
    return created;
}
/**
 * Gives each request its deal: `qty` boxes, held for 24 hours, and tells the buyer his rate is ready
 * (the existing `rate_ready` message; the id it carries is the request's). Inside the caller's
 * transaction — the pile's confirmation, or Sales dividing a short one.
 */
export async function offerPileRequests(items, session, now = new Date()) {
    const holdUntil = addHours(now, PILE_OFFER_HOLD_HOURS);
    for (const { request, qty } of items) {
        await PileRequest.updateOne({ _id: request._id }, { $set: { offerState: 'offered', offerQty: qty, offeredAt: now, holdUntil } }, { session });
        await enqueueNotification({
            counterpartyId: await counterpartyIdForBuyer(request.buyerId, session),
            templateKey: 'rate_ready',
            params: { askId: String(request._id) },
            correlationId: `pile-offer-${String(request._id)}`,
        }, session);
    }
}
function closedError(state) {
    const text = state === 'ordered'
        ? 'This deal has already been ordered.'
        : state === 'declined'
            ? 'This deal was walked away from.'
            : state === 'expired'
                ? 'The 24-hour hold on this deal has run out.'
                : 'There is no deal given on this request.';
    return new AppError({ code: 'PILE_OFFER_CLOSED', messageEn: text });
}
/** The request, if it is this buyer's. */
async function requestOfBuyer(requestId, buyerCounterpartyId) {
    assertValidObjectId(requestId, 'requestId');
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    const request = buyer ? await PileRequest.findOne({ _id: requestId, buyerId: buyer._id }) : null;
    if (!request)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'No such request.' });
    return request;
}
/**
 * Puts one request's held boxes back on the listing and closes the deal as `outcome`. Only an
 * `offered` one can be released, and the claim is one conditional update, so a buyer accepting
 * and the clock releasing at the same instant cannot both win. Returns whether it released.
 */
async function releaseOffer(requestId, outcome, actor, session) {
    const claimed = await PileRequest.findOneAndUpdate({ _id: requestId, offerState: 'offered' }, { $set: { offerState: outcome } }, { session });
    if (!claimed)
        return false;
    const pile = await Pile.findById(claimed.pileId).session(session);
    if (pile) {
        await ListingLine.updateOne({ _id: pile.listingLineId }, { $inc: { qty: claimed.offerQty ?? 0 } }, { session });
    }
    await writeAuditLog({
        actorId: actor.actorId,
        actorType: actor.actorType,
        entity: 'pile_request',
        entityId: requestId,
        field: 'offerState',
        oldValue: 'offered',
        newValue: outcome,
        correlationId: actor.correlationId,
    }, session);
    return true;
}
/**
 * The buyer takes the deal: his order is made, for the boxes offered, and its payment window starts
 * now. Refused once it is ordered, walked away from, or past the 24-hour hold (which then releases
 * the boxes). The order, the request's state and the audit entry commit together.
 */
export async function acceptPileOffer(requestId, buyerCounterpartyId, actor, now = new Date(), adjustment) {
    await assertMarketplaceOpen(); // RECTIFY-01 — a paused marketplace takes no deal.
    const request = await requestOfBuyer(requestId, buyerCounterpartyId);
    if (request.offerState === 'offered' && request.holdUntil && request.holdUntil <= now) {
        await expirePileOffer(requestId, now);
        throw closedError('expired');
    }
    if (request.offerState !== 'offered')
        throw closedError(request.offerState);
    return withTransaction(async (session) => {
        const claimed = await PileRequest.findOneAndUpdate({ _id: requestId, offerState: 'offered', holdUntil: { $gt: now } }, { $set: { offerState: 'ordered' } }, { session });
        if (!claimed)
            throw closedError('ordered');
        const offered = claimed.offerQty ?? claimed.qty;
        // 4 Nov — an approved Sales change (BR-379): fewer boxes than the seller confirmed, never more.
        if (adjustment && adjustment.boxes > offered) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'The approved boxes are more than the seller confirmed for him.',
            });
        }
        const boxes = adjustment ? adjustment.boxes : offered;
        const pile = await Pile.findById(claimed.pileId).session(session);
        const line = pile ? await ListingLine.findById(pile.listingLineId).session(session) : null;
        const listing = line ? await Listing.findById(line.listingId).session(session) : null;
        const seller = listing ? await Seller.findById(listing.sellerId).session(session) : null;
        if (!line || !seller)
            throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
        const created = await raiseOrderForRequest({
            skuId: String(line.skuId),
            sellerId: String(seller._id),
            sellerNetPaise: line.ratePaise,
            // An approved change is the requesting staff member's act, so a rate override is logged
            // against him — not against whoever presses Confirm.
            actor: {
                employeeId: adjustment ? adjustment.staffId : actor.actorId,
                correlationId: actor.correlationId,
            },
            ...(adjustment?.overrideRatePaise !== undefined
                ? {
                    overrideRatePaise: adjustment.overrideRatePaise,
                    overrideReasonCode: adjustment.overrideReasonCode,
                }
                : {}),
        }, claimed, boxes, session);
        // The boxes he does not take were held off the listing for him: they go back on it.
        if (boxes < offered) {
            await ListingLine.updateOne({ _id: line._id }, { $inc: { qty: offered - boxes } }, { session });
        }
        await writeAuditLog({
            actorId: actor.actorId,
            actorType: actor.actorType,
            entity: 'pile_request',
            entityId: requestId,
            field: 'offerState',
            oldValue: 'offered',
            newValue: 'ordered',
            correlationId: actor.correlationId,
        }, session);
        return { ...created, boxes };
    });
}
/** The buyer walks away: no order, and the boxes go back on the listing. */
export async function declinePileOffer(requestId, buyerCounterpartyId, actor) {
    const request = await requestOfBuyer(requestId, buyerCounterpartyId);
    if (request.offerState !== 'offered')
        throw closedError(request.offerState);
    const released = await withTransaction((session) => releaseOffer(requestId, 'declined', actor, session));
    if (!released)
        throw closedError('ordered');
    return { released };
}
/** The hold ran out (the clock, or a buyer who tried too late): the boxes go back. */
export async function expirePileOffer(requestId, now = new Date()) {
    const request = await PileRequest.findById(requestId, { buyerId: 1 });
    const buyer = request ? await Buyer.findById(request.buyerId, { counterpartyId: 1 }) : null;
    if (!buyer)
        return false;
    return withTransaction((session) => releaseOffer(requestId, 'expired', {
        // The audit log wants a real id: the clock acts on the buyer's deal, as the other clocks do.
        actorId: String(buyer.counterpartyId),
        actorType: 'system',
        correlationId: `pile-offer-expiry-${now.toISOString()}`,
    }, session));
}
/** The deals waiting on this buyer, soonest to lapse first. Ones past their hold are not shown. */
export async function listPileOffersForBuyer(buyer, now = new Date()) {
    const requests = await PileRequest.find({
        buyerId: buyer._id,
        offerState: 'offered',
        holdUntil: { $gt: now },
    }).sort({ holdUntil: 1 });
    if (requests.length === 0)
        return [];
    const piles = await Pile.find({ _id: { $in: requests.map((r) => r.pileId) } });
    const pileById = new Map(piles.map((p) => [String(p._id), p]));
    const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
    const lineById = new Map(lines.map((l) => [String(l._id), l]));
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [String(s._id), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const rows = [];
    for (const request of requests) {
        const pile = pileById.get(String(request.pileId));
        const line = pile ? lineById.get(String(pile.listingLineId)) : undefined;
        if (!pile || !line)
            continue;
        const sku = skuById.get(String(line.skuId));
        const product = sku ? productById.get(String(sku.productId)) : undefined;
        rows.push({
            requestId: String(request._id),
            pileId: String(pile._id),
            listingLineId: String(line._id),
            productId: product ? String(product._id) : null,
            brand: product?.brand ?? '—',
            packLabel: sku?.packLabel ?? null,
            boxes: request.offerQty ?? request.qty,
            askedBoxes: request.qty,
            ratePaise: await computeBuyerFacingRatePaise(buyer, line.skuId, line.ratePaise),
            expiryExact: pile.expiryExact ?? line.expiryExact ?? null,
            expiryBand: line.expiryBand,
            deliveryBand: line.deliveryBand,
            offeredAt: (request.offeredAt ?? now).toISOString(),
            holdUntil: request.holdUntil.toISOString(),
        });
    }
    return rows;
}
/** The same for a buyer given by his counterparty id (his own app). */
export async function listMyPileOffers(buyerCounterpartyId) {
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    if (!buyer)
        return [];
    return listPileOffersForBuyer(buyer);
}
