import { z } from 'zod';
import { numberSetting } from '../../db/settings.js';
import { BuyerModel, ListingModel, SellerModel, SkuModel, } from '../../models/index.js';
import { DECLINE_REASONS } from '../../shared/enums.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { clip } from '../../shared/text.js';
import { reasonFor } from '../masters/reasons.js';
import { objectId } from '../parties/common.js';
import { computeBuyerRate, loadMargins, pricingTierOf } from '../pricing/pricing.js';
import { arrivalInput, correctInspection as saveCorrection, correctionNotes, inspectionInput, inspectionNotes, inspectLot as runInspection, recordArrival as saveArrival, } from '../dock/dock.js';
import { margBillInput, recordMargBill as saveMargBill } from '../billing/billing.js';
import { closeLostInTransit as saveLost, lostInput, lostNotes } from '../dock/lostInTransit.js';
import { holdInput, holdPayout as saveHold, releaseHold as saveRelease } from '../payouts/hold.js';
import { raiseComplaint as saveComplaint, raiseInput as complaintInput, resolveComplaint as saveResolution, resolveInput as resolutionInput, } from '../complaints/complaints.js';
import { spendAdvance } from '../payments/advances.js';
import { confirmReceipt, logReceipt, rejectReceipt } from '../payments/payments.js';
import { recordSellerPayment as savePayment, sellerPaymentInput } from '../payouts/payouts.js';
import { dispatchInput, leg1Summary, recordDispatch as saveDispatch, recordSellerBill as saveSellerBill, sellerBillInput, } from '../purchaseOrders/dispatch.js';
import { raisePurchaseOrder } from '../purchaseOrders/purchaseOrders.js';
import { markDelivered } from '../salesOrders/salesOrders.js';
import { podInput, recordPod as savePod } from '../trips/trips.js';
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
 * Leakage or Dock rejected → b2: the buyer is interested again. The old seller answer, offer and order links are
 * cleared (the old order, PO and any refund due stay on record), so "Send to seller" starts the seller side afresh.
 */
const reopen = command(z.object({}), () => ({
    set: { buyerStage: 'B2_INQUIRY' },
    unset: [
        'leakage',
        'sellerStage',
        'sellerId',
        'sellerAnswer',
        'offer',
        'salesOrderId',
        'purchaseOrderId',
        'dueAt',
    ],
    buyerNote: 'Reopened: send it to the seller again when the buyer is ready',
    sellerNote: '',
}));
// ---------------------------------------------------------------------------------------------------------------
// Gate A: the buyer pays (FR-PAY, SRS-PAY-01..03; Q-ACC-01 = full payment before the PO)
const paymentInput = z.object({
    bankLedgerId: objectId,
    // A bank reference: letters and digits, spaces and dashes removed, capitals.
    utr: z
        .string()
        .transform((text) => text.replace(/[\s-]/g, '').toUpperCase())
        .pipe(z.string().regex(/^[0-9A-Z]{6,30}$/, 'A UTR has 6 to 30 letters or digits.')),
    amountPaise: z.number().int().min(1, 'Enter the amount.').max(100_000_000_000),
    receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date the money came in.'),
});
/**
 * b6: Sales enters what the buyer says he paid (bank, UTR, amount, date). Not money yet: Accounts must find it in
 * the bank. The trade stays at b6.
 */
const enterPayment = command(paymentInput, async (ctx, input) => {
    const { receipt } = await logReceipt(ctx, input);
    return {
        set: {},
        buyerNote: `Payment entered: ${formatRupees(receipt.amountPaise)}, UTR ${receipt.utr} (${receipt.number}). Waiting for Accounts`,
        sellerNote: '',
    };
});
/**
 * Gate A: the order is paid in full, so the PO goes to the seller: b6 → b7, s2 → s3, the dispatch clock starts.
 * Shared by `confirmPayment` and `useAdvance`: both end here.
 */
async function openGateA(ctx, order, paid) {
    const po = await raisePurchaseOrder(ctx, order);
    return {
        set: {
            buyerStage: 'B7_PAID',
            sellerStage: 'S3_PO',
            purchaseOrderId: po._id,
            dueAt: po.dispatchDueAt,
        },
        buyerNote: `${paid}. ${order.number} is paid in full`,
        sellerNote: `${po.number} raised: the seller should dispatch`,
    };
}
/**
 * Accounts found the money (never the person who entered it). Posts the RECEIPT voucher (Dr bank · Cr buyer).
 * Paid in full → the order is PAID, the PO goes to the seller: b6 → b7, s2 → s3, the dispatch clock starts.
 * Less → an advance: the order waits at b6 for the rest.
 */
const confirmPayment = command(z.object({ receiptId: objectId }), async (ctx, input) => {
    const done = await confirmReceipt(ctx, input.receiptId);
    const paid = `Payment confirmed: ${formatRupees(done.receipt.amountPaise)} (${done.voucher.number})`;
    if (!done.paidInFull) {
        return {
            set: {},
            buyerNote: `${paid}. Advance kept: ${formatRupees(done.stillDuePaise)} still due on ${done.order.number}`,
            sellerNote: '',
        };
    }
    return openGateA(ctx, done.order, paid);
});
/**
 * Build 9: Accounts puts the buyer's advance (a hand-added payment already posted) on this order, oldest payment
 * first and never more than the order needs. Paid in full → Gate A exactly like a confirmed payment.
 */
const useAdvance = command(z.object({}), async (ctx) => {
    const done = await spendAdvance(ctx);
    const paid = `Advance used: ${formatRupees(done.usedPaise)} from ${done.used.map((item) => item.number).join(', ')}`;
    if (!done.paidInFull) {
        return {
            set: {},
            buyerNote: `${paid}. ${formatRupees(done.stillDuePaise)} still due on ${done.order.number}`,
            sellerNote: '',
        };
    }
    return openGateA(ctx, done.order, paid);
});
/** Accounts could not find the money: the entry is marked not received, with a note for Sales. */
const rejectPayment = command(z.object({
    receiptId: objectId,
    note: z
        .string()
        .trim()
        .min(1, 'Say what was wrong, e.g. "No such UTR in the HDFC statement".')
        .max(300),
}), async (ctx, input) => {
    const receipt = await rejectReceipt(ctx, input.receiptId, input.note);
    return {
        set: {},
        buyerNote: `${receipt.number} (${formatRupees(receipt.amountPaise)}, UTR ${receipt.utr}) not found in the bank: ${input.note}`,
        sellerNote: '',
    };
});
/** Every action's command. The engine looks the action up here. */
// ---------------------------------------------------------------------------------------------------------------
// Build 3: leg 1 (Purchase) and the Indore dock (Logistics), LOCK-40
const DAY_MS = 24 * 60 * 60 * 1000;
/** s3 → s5 On the way: Purchase records how the seller sent the goods. The arrival clock starts. */
const recordDispatch = command(dispatchInput, async (ctx, input) => {
    const { leg1 } = await saveDispatch(ctx, input);
    const days = await numberSetting('TRANSIT_OVERDUE_DAYS', 4);
    const freight = input.freightTerms === 'TO_PAY' && input.freightPaise
        ? `, freight ${formatRupees(input.freightPaise)} to pay at Indore`
        : ', freight paid by the seller';
    return {
        set: { sellerStage: 'S5_DISPATCHED', dueAt: new Date(ctx.now.getTime() + days * DAY_MS) },
        buyerNote: 'Goods on the way to the Indore dock',
        sellerNote: `Dispatched on ${input.dispatchedOn} ${leg1Summary(leg1)}${freight}`,
    };
});
/** The seller's tax invoice (any time from the PO until he is paid). The stage does not move. */
const recordSellerBill = command(sellerBillInput, async (ctx, input) => {
    const { note, replaced } = await saveSellerBill(ctx, input);
    return {
        set: {},
        buyerNote: '',
        sellerNote: replaced ? `${note} (replaces the earlier bill)` : note,
    };
});
/** s5 On the way → s5 At the dock: Logistics records the arrival. The dock must check within a day. */
const recordArrival = command(arrivalInput, async (ctx, input) => {
    const { inspectBy, ordered } = await saveArrival(ctx, input);
    const bill = input.billWithGoods
        ? 'seller bill came with the goods'
        : 'no seller bill with the goods';
    return {
        set: { sellerStage: 'S5_ARRIVED', dueAt: inspectBy },
        buyerNote: 'Goods arrived at the Indore dock',
        sellerNote: `Arrived: ${input.boxesCounted} boxes counted for ${ordered} ordered; ${bill}`,
    };
});
/**
 * Gate B: the dock checks the goods line by line. Some accepted → b8 To be billed / s6 (the PURCHASE voucher is
 * posted). Nothing accepted (O4) → Dock rejected / Closed: the buyer is owed a full refund; Sales may reopen.
 */
const inspectLot = command(inspectionInput, async (ctx, input) => {
    const result = await runInspection(ctx, input);
    const notes = inspectionNotes(result);
    if (result.outcome === 'O4') {
        return {
            set: { buyerStage: 'X_DOCK_REJECTED', sellerStage: 'S_CLOSED' },
            unset: ['dueAt'],
            ...notes,
        };
    }
    return {
        set: { buyerStage: 'B8_BILLED', sellerStage: 'S6_PAYMENT' },
        unset: ['dueAt'],
        ...notes,
    };
});
/**
 * Build 9: the dock typed a wrong count and sees it before the Marg bill is saved. A new check replaces the first;
 * its voucher, return notes and refund are replaced too. The deal stays where it is (b8 / s6).
 */
const correctInspection = command(inspectionInput, async (ctx, input) => {
    const result = await saveCorrection(ctx, input);
    return { set: {}, ...correctionNotes(result) };
});
// ---------------------------------------------------------------------------------------------------------------
// Build 4: the Marg bill (Accounts), the proof of dispatch on a trip (Logistics), delivery (Sales)
/** b8: Accounts keys the Marg invoice; the checks pass, the SALES voucher is posted. The stage stays b8. */
const recordMargBill = command(margBillInput, async (ctx, input) => {
    const { note } = await saveMargBill(ctx, input);
    return { set: {}, buyerNote: note, sellerNote: '' };
});
/** b8 → b9 Dispatched: the POD for this bill on a trip that is out. The delivery window starts. */
const recordPod = command(podInput, async (ctx, input) => {
    const { tripCode, via } = await savePod(ctx, input);
    const days = await numberSetting('DELIVERY_WINDOW_DAYS', 7);
    // The delivery window is also the complaint window: both end at the same moment (kept after delivery).
    const windowEnds = new Date(ctx.now.getTime() + days * DAY_MS);
    return {
        set: { buyerStage: 'B9_DISPATCH', dueAt: windowEnds, complaintByAt: windowEnds },
        buyerNote: `Dispatched to the buyer on trip ${tripCode}: ${via}`,
        sellerNote: '',
    };
});
/** b9 → b10 Delivered: Sales confirms the buyer has the goods. */
const confirmDelivery = command(z.object({}), async (ctx) => {
    await markDelivered(ctx);
    return {
        set: { buyerStage: 'B10_DELIVERED' },
        unset: ['dueAt'],
        buyerNote: 'Delivered: the buyer has the goods',
        sellerNote: '',
    };
});
/**
 * b9/b10 → b11 Complaint: Sales records the buyer's complaint inside the delivery window (7 days after the proof of
 * dispatch). The silence clock stops; the Controller is due to decide within SLA_B11_HOURS.
 */
const raiseComplaint = command(complaintInput, async (ctx, input) => {
    const { resolveByAt, note } = await saveComplaint(ctx, input);
    return {
        set: { buyerStage: 'B11_COMPLAINTS', dueAt: resolveByAt },
        buyerNote: note,
        sellerNote: '',
    };
});
/**
 * b11 → b10 Delivered: the Controller decides (no action, credit, replacement, return or refund). A credit or
 * refund posts a credit note; a refund also waits in Payouts. Sales reads the decision on the card.
 */
const resolveComplaint = command(resolutionInput, async (ctx, input) => {
    const { deliver, note } = await saveResolution(ctx, input);
    if (deliver)
        await markDelivered(ctx);
    return {
        set: { buyerStage: 'B10_DELIVERED' },
        unset: ['dueAt'],
        buyerNote: note,
        sellerNote: '',
    };
});
/**
 * b9 → b10 Delivered, by the system (Q-LOG-09): the 7-day window ended and no complaint came. Only the clock
 * (modules/clocks) presses it, as 'SYSTEM'; nobody can press it by hand.
 */
const silenceDelivery = command(z.object({}), async (ctx) => {
    if (!ctx.trade.dueAt || ctx.trade.dueAt > ctx.now) {
        throw conflict('The delivery window has not ended yet.', 'WINDOW_OPEN');
    }
    await markDelivered(ctx);
    return {
        set: { buyerStage: 'B10_DELIVERED' },
        unset: ['dueAt'],
        buyerNote: 'Delivered: no complaint came within the delivery window',
        sellerNote: '',
    };
});
/** s6 → Closed: Accounts types the bank's UTR for the seller's line in a released payout batch (Q-ACC-11). */
const recordSellerPayment = command(sellerPaymentInput, async (ctx, input) => {
    const { note } = await savePayment(ctx, input);
    return { set: { sellerStage: 'S_CLOSED' }, buyerNote: '', sellerNote: note };
});
// ---------------------------------------------------------------------------------------------------------------
// Build 7: Lost in transit, a hold on a seller's payout, and the b1 archive clock
/**
 * s5 On the way → Closed (Controller): the goods never reached the dock and the arrival clock has run out (O8).
 * The buyer is refunded in full, the seller gets a strike, nothing is owed to the seller. Sales may reopen the deal.
 */
const closeLostInTransit = command(lostInput, async (ctx, input) => {
    const result = await saveLost(ctx, input);
    return {
        set: { buyerStage: 'X_LOST_IN_TRANSIT', sellerStage: 'S_CLOSED' },
        unset: ['dueAt'],
        ...lostNotes(result, input),
    };
});
/** s6 (Controller): do not pay this seller for now. The stage does not move; the PO shows "On hold: reason". */
const holdPayout = command(holdInput, async (ctx, input) => {
    await saveHold(ctx, input);
    return { set: {}, buyerNote: '', sellerNote: clip(`Payout held: ${input.reason}`) };
});
/** s6 (Controller): the seller may be paid again. */
const releaseHold = command(z.object({}), async (ctx) => {
    const { reason } = await saveRelease(ctx);
    return { set: {}, buyerNote: '', sellerNote: clip(`Payout hold released (was: ${reason})`) };
});
/**
 * b1 → Archived: nobody touched this viewing for B1_ARCHIVE_DAYS. Only the system presses it (modules/clocks).
 * The viewing never had a seller, an order or money, so nothing else changes; Sales opens a new one from the board.
 */
const archiveViewing = command(z.object({}), async (ctx) => {
    const days = await numberSetting('B1_ARCHIVE_DAYS', 7);
    if (ctx.trade.lastActionAt.getTime() > ctx.now.getTime() - days * DAY_MS) {
        throw conflict('This viewing was touched lately.', 'NOT_IDLE');
    }
    return {
        set: { buyerStage: 'X_ARCHIVED' },
        unset: ['dueAt'],
        buyerNote: `Archived: nobody touched this viewing for ${days} days`,
        sellerNote: '',
    };
});
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
    enterPayment,
    confirmPayment,
    useAdvance,
    rejectPayment,
    recordDispatch,
    recordSellerBill,
    recordArrival,
    inspectLot,
    correctInspection,
    recordMargBill,
    recordPod,
    confirmDelivery,
    recordSellerPayment,
    raiseComplaint,
    resolveComplaint,
    silenceDelivery,
    closeLostInTransit,
    holdPayout,
    releaseHold,
    archiveViewing,
};
//# sourceMappingURL=commands.js.map