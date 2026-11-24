import { z } from 'zod';
import { numberSetting } from '../../db/settings.js';
import { BuyerModel, ListingModel, ReasonCodeModel, SellerModel, SkuModel, } from '../../models/index.js';
import { DECLINE_REASONS } from '../../shared/enums.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { objectId } from '../parties/common.js';
import { computeBuyerRate, loadMargins, pricingTierOf } from '../pricing/pricing.js';
import { cancelSalesOrder, raiseSalesOrder } from '../salesOrders/salesOrders.js';
import { earliestExpiryMonth, monthsFromNow } from './stages.js';
/** Ties an input schema to its handler, so the handler always gets checked, typed input. */
function command(input, handler) {
    return { run: async (ctx, rawInput) => handler(ctx, input.parse(rawInput)) };
}
const DEFAULT_HOURS = { SLA_S0_HOURS: 7, SLA_S1_HOURS: 12, SELLER_HOLD_HOURS: 24 };
const DEFAULT_SHELF_LIFE_FLOOR_MONTHS = 6;
/** The time `key` hours from now (the hours come from Settings). */
async function hoursFrom(now, key) {
    const hours = await numberSetting(key, DEFAULT_HOURS[key]);
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
}
const boxes = z.number().int().min(1, 'Enter at least 1 box').max(1_000_000);
const expiryMonth = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the expiry month as YYYY-MM (for example 2027-06)');
const optionalText = (max) => z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((text) => text || undefined);
/** The expiry month must leave at least SHELF_LIFE_FLOOR_MONTHS of shelf life. */
async function checkExpiry(month, now) {
    const floor = await numberSetting('SHELF_LIFE_FLOOR_MONTHS', DEFAULT_SHELF_LIFE_FLOOR_MONTHS);
    if (monthsFromNow(month, now) < floor) {
        const earliest = earliestExpiryMonth(floor, now);
        throw invalidField('expiryMonth', `The stock needs at least ${floor} months of shelf life: expiry ${earliest} or later.`);
    }
}
/**
 * The rate Sales offers the buyer, fixed when the seller answers (buyer side of the wall).
 * Same pricing as the rate board: landed rate + the margin for the pack's class and the buyer's tier.
 */
async function offerFor(trade, skuClass, landedPaise, now) {
    const buyer = await BuyerModel.findById(trade.buyerId).orFail();
    const { tier, indicative } = pricingTierOf(buyer);
    const marginBp = (await loadMargins(now)).marginFor(skuClass, tier);
    return {
        buyerRatePaisePerUnit: marginBp === null ? null : computeBuyerRate(landedPaise, marginBp),
        tier,
        indicative,
    };
}
/** The listing behind a LISTED trade (it may have been paused or withdrawn since; the trade keeps going). */
async function listingOf(trade) {
    if (!trade.listingId)
        throw conflict('This trade has no listing.', 'NO_LISTING');
    return ListingModel.findById(trade.listingId).orFail();
}
function isLive(listing, now) {
    return listing.status === 'ACTIVE' && listing.expiresAt > now;
}
// ---------------------------------------------------------------------------------------------------------------
// Sales (buyer side)
/** b1 → b2: the buyer wants this many boxes. At least the listing's minimum order. */
const wantIt = command(z.object({ boxes }), async ({ trade, now }, input) => {
    const listing = await listingOf(trade);
    if (!isLive(listing, now)) {
        throw conflict('This listing is no longer live. Go back to the rate board.', 'LISTING_UNAVAILABLE');
    }
    if (input.boxes < listing.moqBoxes) {
        throw invalidField('boxes', `The minimum order is ${listing.moqBoxes} boxes.`);
    }
    return {
        set: { buyerStage: 'B2_INQUIRY', boxesWanted: input.boxes },
        buyerNote: `Wants ${input.boxes} boxes`,
        sellerNote: '',
    };
});
/**
 * b2 → b3. A trade with a live listing goes to that listing's seller (s1). Anything else (not listed, the seller
 * declined, or the listing has ended) goes to Purchase to find a seller (s0).
 */
const sendToSeller = command(z.object({}), async ({ trade, now }) => {
    const listing = trade.listingId ? await ListingModel.findById(trade.listingId) : null;
    if (listing && isLive(listing, now)) {
        return {
            set: {
                buyerStage: 'B3_PENDING_SELLER',
                sellerStage: 'S1_CONFIRMATION',
                sellerId: listing.sellerId,
                dueAt: await hoursFrom(now, 'SLA_S1_HOURS'),
            },
            buyerNote: 'Sent to the seller',
            sellerNote: `Please confirm ${trade.boxesWanted ?? 0} boxes from the listing`,
        };
    }
    return {
        set: {
            buyerStage: 'B3_PENDING_SELLER',
            sellerStage: 'S0_DEMAND',
            dueAt: await hoursFrom(now, 'SLA_S0_HOURS'),
        },
        unset: ['sellerId', 'listingId'],
        buyerNote: listing
            ? 'The listing has ended: sent to Purchase to find a seller'
            : 'Sent to Purchase to find a seller',
        sellerNote: `Find a seller for ${trade.boxesWanted ?? 0} boxes`,
    };
});
// ---------------------------------------------------------------------------------------------------------------
// Purchase (seller side)
const confirmInput = z.object({
    boxes,
    expiryMonth,
    batchNumber: optionalText(60),
});
/**
 * The listed seller confirms (s1; buyer b3 → b4): boxes up to what the buyer wants, the exact expiry month, and
 * the batch when it is the seller's own stock. Fixes the buyer's rate and starts the seller's hold clock.
 */
const confirmStock = command(confirmInput, async ({ trade, userId, now }, input) => {
    const listing = await listingOf(trade);
    const wanted = trade.boxesWanted ?? 0;
    if (input.boxes > wanted) {
        throw invalidField('boxes', `The buyer wants ${wanted} boxes; the seller can confirm up to that.`);
    }
    await checkExpiry(input.expiryMonth, now);
    if (listing.provenance === 'OWN_STOCK' && !input.batchNumber) {
        throw invalidField('batchNumber', 'Enter the batch number: this is the seller’s own stock.');
    }
    const sku = await SkuModel.findById(listing.skuId).orFail();
    const landed = listing.ratePaisePerUnit;
    return {
        set: {
            buyerStage: 'B4_SEND_CONFIRMATION',
            sellerAnswer: {
                kind: 'CONFIRMED',
                boxes: input.boxes,
                landedPaisePerUnit: landed,
                unitsPerBox: listing.unitsPerBoxSnapshot,
                expiryMonth: input.expiryMonth,
                ...(input.batchNumber ? { batchNumber: input.batchNumber } : {}),
                byUserId: userId,
                at: now,
            },
            offer: await offerFor(trade, sku.skuClass, landed, now),
            dueAt: await hoursFrom(now, 'SELLER_HOLD_HOURS'),
        },
        buyerNote: `Seller confirmed ${input.boxes} boxes, expiry ${input.expiryMonth}`,
        sellerNote: `Confirmed ${input.boxes} boxes at ${formatRupees(landed)} a unit, expiry ${input.expiryMonth}` +
            (input.batchNumber ? `, batch ${input.batchNumber}` : ''),
    };
});
/** Seller-facing reason labels (also shown to Sales: they name no one). */
export const DECLINE_REASON_LABELS = {
    NO_STOCK: 'No stock',
    RATE_CHANGED: 'Rate changed',
    EXPIRY_TOO_SHORT: 'Expiry too short',
    OTHER: 'Other',
};
const declineInput = z
    .object({ reason: z.enum(DECLINE_REASONS, 'Choose a reason'), note: optionalText(300) })
    .refine((value) => value.reason !== 'OTHER' || value.note, {
    path: ['note'],
    message: 'Write a short note for "Other"',
});
/**
 * The listed seller says no (s1 closes; buyer back to b2). The seller and listing are cleared, so sending again
 * goes to Purchase to find another seller (Q-PUR-09). Sales may also pick another row on the rate board.
 */
const declineStock = command(declineInput, (_ctx, input) => {
    const reason = DECLINE_REASON_LABELS[input.reason];
    const text = input.note ? `${reason}: ${input.note}` : reason;
    return {
        set: { buyerStage: 'B2_INQUIRY' },
        unset: ['sellerStage', 'sellerId', 'listingId', 'dueAt'],
        buyerNote: `Seller declined (${text}). Send again for Purchase to find another seller.`,
        sellerNote: `Declined: ${text}`,
    };
});
const quoteInput = z.object({
    sellerId: objectId,
    skuId: objectId,
    landedPaisePerUnit: z.number().int().min(1, 'Enter the rate').max(100_000_000),
    expiryMonth,
    moqBoxes: boxes,
    boxesAvailable: boxes,
    batchNumber: optionalText(60),
});
/**
 * Purchase found a seller for a not-listed item and records his quote (s0 → s1; buyer b3 → b4): the seller,
 * the pack, his landed rate per unit, expiry month, minimum order and boxes available. The buyer is offered
 * the smaller of what he wants and what the seller has. Fixes the buyer's rate and starts the hold clock.
 */
const giveQuote = command(quoteInput, async ({ trade, userId, now }, input) => {
    const seller = await SellerModel.findById(input.sellerId);
    if (!seller?.active)
        throw invalidField('sellerId', 'Choose an active seller.');
    const sku = await SkuModel.findById(input.skuId);
    if (!sku?.active || !sku.productId.equals(trade.productId)) {
        throw invalidField('skuId', 'Choose an active pack of this product.');
    }
    if (trade.skuId && !trade.skuId.equals(sku._id)) {
        throw invalidField('skuId', 'The buyer asked for a different pack.');
    }
    await checkExpiry(input.expiryMonth, now);
    const wanted = trade.boxesWanted ?? 0;
    const offered = Math.min(wanted, input.boxesAvailable);
    if (offered < input.moqBoxes) {
        throw invalidField('moqBoxes', `The seller's minimum (${input.moqBoxes} boxes) is more than can be offered (${offered}).`);
    }
    return {
        set: {
            buyerStage: 'B4_SEND_CONFIRMATION',
            sellerStage: 'S1_CONFIRMATION',
            sellerId: seller._id,
            skuId: sku._id,
            sellerAnswer: {
                kind: 'QUOTED',
                boxes: offered,
                landedPaisePerUnit: input.landedPaisePerUnit,
                unitsPerBox: sku.unitsPerBox,
                expiryMonth: input.expiryMonth,
                ...(input.batchNumber ? { batchNumber: input.batchNumber } : {}),
                moqBoxes: input.moqBoxes,
                boxesAvailable: input.boxesAvailable,
                byUserId: userId,
                at: now,
            },
            offer: await offerFor(trade, sku.skuClass, input.landedPaisePerUnit, now),
            dueAt: await hoursFrom(now, 'SELLER_HOLD_HOURS'),
        },
        buyerNote: `Seller found: ${offered} boxes of ${sku.packLabel}, expiry ${input.expiryMonth}`,
        sellerNote: `Quote from ${seller.number}: ${offered} boxes of ${sku.packLabel} at ${formatRupees(input.landedPaisePerUnit)} a unit, expiry ${input.expiryMonth}, minimum ${input.moqBoxes}`,
    };
});
// ---------------------------------------------------------------------------------------------------------------
// Sales again: the buyer's answer (FR-ORD-02)
/** A reason picked from the reason codes master: it must exist, be turned on and belong to this dropdown. */
async function reasonFor(reasonCodeId, context) {
    const reason = await ReasonCodeModel.findById(reasonCodeId);
    if (!reason?.active || reason.context !== context) {
        throw invalidField('reasonCodeId', 'Choose a reason from the list.');
    }
    return reason;
}
const reasonInput = z.object({ reasonCodeId: objectId, note: optionalText(300) });
/**
 * b4 → b5: Sales sends the offer to the buyer (boxes, rate, expiry) and waits for his call. The seller keeps
 * holding the stock on the same clock. If the margin matrix had no cell when the seller answered, the rate is
 * worked out now; if there is still none, the offer cannot be sent.
 */
const sendToBuyer = command(z.object({}), async ({ trade, now }) => {
    const answer = trade.sellerAnswer;
    if (!answer || !trade.offer || !trade.skuId) {
        throw conflict('The seller has not answered yet.', 'NO_SELLER_ANSWER');
    }
    let rate = trade.offer.buyerRatePaisePerUnit ?? null;
    let newOffer = null;
    if (rate === null) {
        const sku = await SkuModel.findById(trade.skuId).orFail();
        newOffer = await offerFor(trade, sku.skuClass, answer.landedPaisePerUnit, now);
        rate = newOffer.buyerRatePaisePerUnit;
        if (rate === null) {
            throw conflict("There is no rate yet: the margin matrix has no box for this pack and this buyer's tier. Ask Founder or Admin to fill it, then send again.", 'RATE_UNAVAILABLE');
        }
    }
    return {
        set: { buyerStage: 'B5_BUYERS_CALL', ...(newOffer ? { offer: newOffer } : {}) },
        buyerNote: `Offer sent: ${answer.boxes} boxes at ${formatRupees(rate)} a unit (${formatRupees(rate * answer.unitsPerBox)} a box), expiry ${answer.expiryMonth}`,
        sellerNote: '',
    };
});
/**
 * b5 → b6, seller s1 → s2: the buyer says yes. The engine raises his sales order (SO-26-0001) with the fixed
 * rate and GST, and the payment clock starts (PAYMENT_WINDOW_HOURS). The seller holds the stock until payment.
 */
const buyerYes = command(z.object({}), async (ctx) => {
    const order = await raiseSalesOrder(ctx);
    const boxes = ctx.trade.sellerAnswer?.boxes ?? 0;
    return {
        set: {
            buyerStage: 'B6_ORDER_CONFIRMED',
            sellerStage: 'S2_HOLD',
            salesOrderId: order._id,
            dueAt: order.paymentDueAt,
        },
        buyerNote: `Buyer said yes: ${order.number} for ${formatRupees(order.totalPaise)}`,
        sellerNote: `The buyer confirmed ${boxes} boxes: the seller holds them until the buyer pays`,
    };
});
const RELEASED_NOTE = 'The buyer did not take it: the seller may sell the stock to someone else';
/** b5 → Leakage: the buyer says no, with a reason (reason codes, context BUYER_NO). The seller's hold ends. */
const buyerNo = command(reasonInput, async ({ trade, userId, now }, input) => {
    const reason = await reasonFor(input.reasonCodeId, 'BUYER_NO');
    return {
        set: {
            buyerStage: 'X_LEAKAGE',
            ...(trade.sellerStage ? { sellerStage: 'S_RELEASED' } : {}),
            leakage: {
                context: 'BUYER_NO',
                reasonCodeId: reason._id,
                reasonLabel: reason.label,
                ...(input.note ? { note: input.note } : {}),
                byUserId: userId,
                at: now,
            },
        },
        unset: ['dueAt'],
        buyerNote: `Buyer said no: ${reason.label}${input.note ? ` (${input.note})` : ''}`,
        sellerNote: RELEASED_NOTE,
    };
});
/**
 * b6 → Leakage: the buyer drops the order before paying (reason codes, context B6_LEAK). His sales order is
 * cancelled and the seller's hold ends. Refunds for money already paid come with payments (next build).
 */
const leakAfterOrder = command(reasonInput, async (ctx, input) => {
    const reason = await reasonFor(input.reasonCodeId, 'B6_LEAK');
    const order = await cancelSalesOrder(ctx, {
        reasonCodeId: reason._id,
        reasonLabel: reason.label,
        note: input.note,
    });
    return {
        set: {
            buyerStage: 'X_LEAKAGE',
            sellerStage: 'S_RELEASED',
            leakage: {
                context: 'B6_LEAK',
                reasonCodeId: reason._id,
                reasonLabel: reason.label,
                ...(input.note ? { note: input.note } : {}),
                byUserId: ctx.userId,
                at: ctx.now,
            },
        },
        unset: ['dueAt'],
        buyerNote: `Buyer dropped the order: ${reason.label}${input.note ? ` (${input.note})` : ''}. ${order.number} cancelled.`,
        sellerNote: RELEASED_NOTE,
    };
});
/**
 * Leakage → b2: the buyer is interested again. The old seller answer, offer and order link are cleared (a
 * cancelled order stays on record), so "Send to seller" starts the seller side afresh.
 */
const reopen = command(z.object({}), () => ({
    set: { buyerStage: 'B2_INQUIRY' },
    unset: ['leakage', 'sellerStage', 'sellerId', 'sellerAnswer', 'offer', 'salesOrderId', 'dueAt'],
    buyerNote: 'Reopened: send it to the seller again when the buyer is ready',
    sellerNote: '',
}));
/** Every action's command. The engine looks the action up here. */
export const COMMANDS = {
    wantIt,
    sendToSeller,
    giveQuote,
    confirmStock,
    declineStock,
    sendToBuyer,
    buyerYes,
    buyerNo,
    leakAfterOrder,
    reopen,
};
//# sourceMappingURL=commands.js.map