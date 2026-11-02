import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Listing } from '../../../models/Listing.js';
import { Seller } from '../../../models/Seller.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { AppError } from '../../../shared/errors.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { withTransaction } from '../../../db/transaction.js';
import { syncEnquiriesForPile } from '../../enquiry/enquiry.sync.js';
import { raiseAsk } from '../../demand/demand.service.js';
import { raiseOrderForRequest } from '../../demand/pileFanout.job.js';
import { recordCallAction } from './sales.calls.js';
const idOf = (value) => String(value);
/**
 * The short piles waiting on the desk. A pile is shown only to someone who can see every buyer on
 * it: dividing boxes between buyers needs all of them, so a pile that spans two books goes to the
 * leader (or Controller) who sees both.
 */
export async function listShortPiles(visibility) {
    const piles = await Pile.find({
        decision: 'confirmed',
        shortfall: true,
        executedAt: { $ne: null },
        shortfallResolvedAt: null,
    }).sort({ decidedAt: 1 });
    if (piles.length === 0)
        return [];
    const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
    const lineById = new Map(lines.map((l) => [idOf(l._id), l]));
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [idOf(s._id), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [idOf(p._id), p]));
    const requests = await PileRequest.find({ pileId: { $in: piles.map((p) => p._id) } }).sort({
        requestedAt: 1,
    });
    const buyers = await Buyer.find({ _id: { $in: requests.map((r) => r.buyerId) } });
    const buyerById = new Map(buyers.map((b) => [idOf(b._id), b]));
    const counterparties = await Counterparty.find({
        _id: { $in: buyers.map((b) => b.counterpartyId) },
    });
    const firmByCounterparty = new Map(counterparties.map((c) => [idOf(c._id), c.firm]));
    const result = [];
    for (const pile of piles) {
        const mine = requests.filter((r) => idOf(r.pileId) === idOf(pile._id));
        if (mine.length === 0)
            continue;
        if (!mine.every((r) => visibility.allowsProfile(idOf(r.buyerId))))
            continue;
        const line = lineById.get(idOf(pile.listingLineId));
        const sku = line ? skuById.get(idOf(line.skuId)) : undefined;
        const product = sku ? productById.get(idOf(sku.productId)) : undefined;
        result.push({
            pileId: idOf(pile._id),
            brand: product?.brand ?? '-',
            packLabel: sku?.packLabel ?? '-',
            canSend: pile.confirmedQty ?? 0,
            asked: mine.reduce((sum, r) => sum + r.qty, 0),
            decidedAt: pile.decidedAt ? pile.decidedAt.toISOString() : null,
            requests: mine.map((r) => {
                const buyer = buyerById.get(idOf(r.buyerId));
                return {
                    pileRequestId: idOf(r._id),
                    buyerId: idOf(r.buyerId),
                    firm: (buyer && firmByCounterparty.get(idOf(buyer.counterpartyId))) || '-',
                    boxes: r.qty,
                    requestedAt: r.requestedAt.toISOString(),
                };
            }),
        });
    }
    return result;
}
/** Whether `allocations` is a fair division of this pile: every buyer once, whole boxes, no more than he asked or the seller can send. */
function assertValidDivision(requests, allocations, canSend) {
    const given = new Map();
    for (const a of allocations) {
        if (given.has(a.pileRequestId)) {
            throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'A buyer is listed twice.' });
        }
        given.set(a.pileRequestId, a.boxes);
    }
    const requestIds = new Set(requests.map((r) => idOf(r._id)));
    if (given.size !== requests.length || [...given.keys()].some((id) => !requestIds.has(id))) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Give a number of boxes (0 if none) for every buyer on the pile.',
        });
    }
    let total = 0;
    for (const r of requests) {
        const boxes = given.get(idOf(r._id));
        if (!Number.isInteger(boxes) || boxes < 0 || boxes > r.qty) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: `A buyer gets whole boxes, from 0 up to the ${r.qty} he asked for.`,
            });
        }
        total += boxes;
    }
    if (total > canSend) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `The seller can send ${canSend} boxes; ${total} is more than that.`,
        });
    }
    return given;
}
/**
 * Divides a short pile. `allocations` names every request on the pile once, with the boxes that
 * buyer gets (0 to what he asked); together they may not exceed what the seller confirmed. The
 * orders, the stock taken off the line, the leftover asks and the "resolved" mark are one
 * transaction: all of it, or none.
 */
export async function resolveShortPile(pileId, input, actor, visibility) {
    assertValidObjectId(pileId, 'pileId');
    const pile = await Pile.findById(pileId);
    if (!pile)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
    if (pile.decision !== 'confirmed' || !pile.executedAt || !pile.shortfall) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This pile is not short, so there is nothing to divide.',
        });
    }
    if (pile.shortfallResolvedAt) {
        throw new AppError({
            code: 'PILE_ALREADY_DECIDED',
            messageEn: 'This short pile has already been divided between the buyers.',
        });
    }
    const requests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
    if (!requests.every((r) => visibility.allowsProfile(idOf(r.buyerId)))) {
        throw new AppError({
            code: 'OUT_OF_SCOPE',
            messageEn: 'Some buyers on this pile are outside your book. Ask the leader to divide it.',
        });
    }
    const canSend = pile.confirmedQty ?? 0;
    const given = assertValidDivision(requests, input.allocations, canSend);
    const total = [...given.values()].reduce((sum, boxes) => sum + boxes, 0);
    const line = await ListingLine.findById(pile.listingLineId);
    const listing = line ? await Listing.findById(line.listingId) : null;
    const seller = listing ? await Seller.findById(listing.sellerId) : null;
    if (!line || !seller)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
    const buyerCounterpartyId = new Map();
    for (const b of await Buyer.find({ _id: { $in: requests.map((r) => r.buyerId) } })) {
        buyerCounterpartyId.set(idOf(b._id), idOf(b.counterpartyId));
    }
    const ctx = {
        skuId: idOf(line.skuId),
        sellerId: idOf(seller._id),
        sellerNetPaise: line.ratePaise,
        actor: { employeeId: actor.employeeId, correlationId: `pile-${pileId}-short` },
    };
    let backOnAskBoxes = 0;
    const outcomes = [];
    const lineQty = await withTransaction(async (session) => {
        // The transaction can be retried: start from nothing each time.
        backOnAskBoxes = 0;
        outcomes.length = 0;
        for (const request of requests) {
            const got = given.get(idOf(request._id));
            const left = request.qty - got;
            if (got > 0)
                await raiseOrderForRequest(ctx, request, got, session);
            if (left > 0) {
                await raiseAsk(buyerCounterpartyId.get(idOf(request.buyerId)), {
                    skuId: idOf(line.skuId),
                    allPacks: false,
                    qty: left,
                    conditionRequirement: {
                        expiryBand: line.expiryBand,
                        ...(line.deliveryBand ? { deliveryBand: line.deliveryBand } : {}),
                    },
                }, { channel: 'sales_call', raisedBy: actor.employeeId, session });
                backOnAskBoxes += left;
            }
            outcomes.push({ buyerId: idOf(request.buyerId), asked: request.qty, got });
        }
        line.qty = Math.max(0, line.qty - total);
        await line.save({ session });
        pile.shortfallResolvedAt = new Date();
        pile.shortfallResolvedBy = actor.employeeId;
        await pile.save({ session });
        await syncEnquiriesForPile(pile._id, session);
        await writeAuditLog({
            actorId: actor.employeeId,
            actorType: 'staff',
            entity: 'pile',
            entityId: pile._id,
            field: 'shortfallResolvedAt',
            // DEC-014: the reason is what the rule staff actually apply is later read from.
            newValue: {
                canSend,
                orderedBoxes: total,
                backOnAskBoxes,
                allocations: outcomes,
                reason: input.reason,
            },
            correlationId: actor.correlationId,
        }, session);
        return line.qty;
    });
    // Each buyer's call history says what he got, so the next call starts from it.
    for (const o of outcomes) {
        const cpId = buyerCounterpartyId.get(o.buyerId);
        if (!cpId)
            continue;
        const note = o.got === o.asked
            ? `Short pile divided: got all ${o.asked} boxes asked for.`
            : o.got > 0
                ? `Short pile divided: got ${o.got} of ${o.asked} boxes; the other ${o.asked - o.got} are open as an ask.`
                : `Short pile divided: got none of the ${o.asked} boxes; they are open as an ask.`;
        await recordCallAction({
            buyerCounterpartyId: cpId,
            employeeId: actor.employeeId,
            outcome: o.got > 0 ? 'placed_an_order' : null,
            note,
        });
    }
    return { orderedBoxes: total, backOnAskBoxes, lineQty };
}
