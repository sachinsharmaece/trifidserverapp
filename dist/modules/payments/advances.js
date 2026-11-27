import mongoose, { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { BuyerModel, LedgerModel, ReceiptModel, SalesOrderModel, TradeModel, } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { isoDateField, istDate } from '../../shared/dates.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { isDuplicateKeyError } from '../../shared/mongo.js';
import { buyerLedger, postVoucher } from '../books/books.js';
import { assertBankDayOpen } from '../books/reconciliation.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { objectId } from '../parties/common.js';
import { unspentPaise } from './allocations.js';
import { openOrder, waitingPaise } from './payments.js';
/**
 * Hand-added payments and the buyer's advance (SRS-PAY-01/02, Build 9). Money can reach our bank with no order to
 * put it against. Accounts adds it by hand; a DIFFERENT person finds it in the bank and posts it (Dr our bank · Cr
 * the buyer, "on account"), or marks it not received. A posted one is an ADVANCE on the buyer's account until it
 * is spent on an order with the engine action `useAdvance` (oldest payment first, never more than the order's due).
 * The first can be undone while nothing is spent (modules/books/reversals.ts); the second is the engine's, so a
 * paid-in-full order raises the PO exactly like a confirmed payment does (Gate A).
 */
export const handReceiptInput = z.object({
    bankLedgerId: objectId,
    buyerId: objectId,
    // A bank reference: letters and digits, spaces and dashes removed, capitals.
    utr: z
        .string()
        .transform((text) => text.replace(/[\s-]/g, '').toUpperCase())
        .pipe(z.string().regex(/^[0-9A-Z]{6,30}$/, 'A UTR has 6 to 30 letters or digits.')),
    amountPaise: z.number().int().min(1, 'Enter the amount.').max(100_000_000_000),
    receivedOn: isoDateField('Enter the date the money came in.'),
    note: z.string().trim().max(300).optional(),
});
/** Accounts adds money that reached the bank with no order. Nothing is posted until a different person confirms. */
export async function addHandReceipt(req, input) {
    const userId = new Types.ObjectId(currentUserOf(req).id);
    const now = new Date();
    return mongoose.connection.transaction(async (session) => {
        const bank = await LedgerModel.findById(input.bankLedgerId).session(session);
        if (!bank?.bank || !bank.active) {
            throw invalidField('bankLedgerId', 'Choose one of our bank accounts.');
        }
        const buyer = await BuyerModel.findById(input.buyerId).session(session);
        if (!buyer)
            throw invalidField('buyerId', 'Choose a buyer from the list.');
        if (input.receivedOn > istDate(now)) {
            throw invalidField('receivedOn', 'The date cannot be in the future.');
        }
        await assertBankDayOpen([{ ledgerId: bank._id, ledgerName: bank.name }], input.receivedOn, session);
        const same = await ReceiptModel.findOne({
            bankLedgerId: bank._id,
            activeUtr: input.utr,
        }).session(session);
        if (same) {
            throw conflict(`UTR ${input.utr} is already entered as ${same.number}.`, 'DUPLICATE_UTR');
        }
        const [receipt] = await ReceiptModel.create([
            {
                number: await nextDocumentNumber('RCPT', { session, at: now }),
                buyerId: buyer._id,
                source: 'HAND_ADDED',
                ...(input.note ? { note: input.note } : {}),
                bankLedgerId: bank._id,
                utr: input.utr,
                activeUtr: input.utr,
                amountPaise: input.amountPaise,
                receivedOn: input.receivedOn,
                status: 'LOGGED',
                enteredBy: userId,
                enteredAt: now,
            },
        ], { session }).catch((error) => {
            if (isDuplicateKeyError(error)) {
                throw conflict(`UTR ${input.utr} is already entered.`, 'DUPLICATE_UTR');
            }
            throw error;
        });
        if (!receipt)
            throw new Error('The payment was not created');
        await writeAudit(req, {
            action: 'receipt.handAdd',
            entityType: 'Receipt',
            entityId: receipt.id,
            after: { number: receipt.number, amountPaise: receipt.amountPaise, utr: receipt.utr },
            session,
        });
        return receipt;
    });
}
/** The hand-added payment, still waiting, for a person who did not add it (maker ≠ checker). */
async function waitingHandReceipt(id, userId, session) {
    const receipt = isValidObjectId(id) ? await ReceiptModel.findById(id).session(session) : null;
    if (!receipt || receipt.source !== 'HAND_ADDED')
        throw notFound('Payment not found.');
    if (receipt.status !== 'LOGGED') {
        throw conflict(`${receipt.number} was already handled.`, 'RECEIPT_NOT_WAITING');
    }
    if (receipt.enteredBy.equals(userId)) {
        throw forbidden('You added this payment: someone else must confirm or reject it.');
    }
    return receipt;
}
/** A different person found the money in the bank: post the RECEIPT voucher, Dr our bank · Cr the buyer. */
export async function postHandReceipt(req, id) {
    const userId = new Types.ObjectId(currentUserOf(req).id);
    const now = new Date();
    await mongoose.connection.transaction(async (session) => {
        const receipt = await waitingHandReceipt(id, userId, session);
        const bank = await LedgerModel.findById(receipt.bankLedgerId).session(session).orFail();
        const buyer = await BuyerModel.findById(receipt.buyerId).session(session).orFail();
        const buyerAccount = await buyerLedger(buyer, userId, session);
        const voucher = await postVoucher(req, {
            type: 'RECEIPT',
            date: receipt.receivedOn,
            narration: `Payment from ${buyer.firmName} on account · UTR ${receipt.utr}`,
            source: { type: 'RECEIPT', id: receipt._id, number: receipt.number },
            lines: [
                { ledger: bank, drPaise: receipt.amountPaise },
                { ledger: buyerAccount, crPaise: receipt.amountPaise },
            ],
            userId,
            now,
        }, session);
        const result = await ReceiptModel.updateOne({ _id: receipt._id, status: 'LOGGED' }, { $set: { status: 'POSTED', postedBy: userId, postedAt: now, voucherId: voucher._id } }, { session });
        if (result.matchedCount !== 1) {
            throw conflict(`${receipt.number} was already handled.`, 'RECEIPT_NOT_WAITING');
        }
        await writeAudit(req, {
            action: 'receipt.post',
            entityType: 'Receipt',
            entityId: receipt.id,
            before: { status: 'LOGGED' },
            after: { status: 'POSTED', voucher: voucher.number, advancePaise: receipt.amountPaise },
            session,
        });
    });
}
export const rejectHandInput = z.object({
    note: z
        .string()
        .trim()
        .min(1, 'Say what was wrong, e.g. "No such UTR in the HDFC statement".')
        .max(300),
});
/** A different person could not find the money: the entry is kept, marked REJECTED, and its UTR may be used again. */
export async function rejectHandReceipt(req, id, note) {
    const userId = new Types.ObjectId(currentUserOf(req).id);
    await mongoose.connection.transaction(async (session) => {
        const receipt = await waitingHandReceipt(id, userId, session);
        const result = await ReceiptModel.updateOne({ _id: receipt._id, status: 'LOGGED' }, {
            $set: { status: 'REJECTED', rejectedBy: userId, rejectedAt: new Date(), rejectNote: note },
            $unset: { activeUtr: 1 },
        }, { session });
        if (result.matchedCount !== 1) {
            throw conflict(`${receipt.number} was already handled.`, 'RECEIPT_NOT_WAITING');
        }
        await writeAudit(req, {
            action: 'receipt.reject',
            entityType: 'Receipt',
            entityId: receipt.id,
            before: { status: 'LOGGED' },
            after: { status: 'REJECTED', note },
            session,
        });
    });
}
// ---------------------------------------------------------------------------------------------------------------
// Using an advance (the engine action `useAdvance`)
/**
 * The buyer's advance goes to the order (FIFO: the oldest payment first), never more than the order still needs
 * after the payments already waiting for Accounts. The order's `paidPaise` grows; paid in full → PAID, and the
 * caller (the engine) raises the PO. Called only from the `useAdvance` command, inside the engine's transaction.
 */
export async function spendAdvance(ctx) {
    const { req, trade, userId, now, session } = ctx;
    const order = await openOrder(ctx);
    const room = order.totalPaise - order.paidPaise - (await waitingPaise(order, ctx));
    if (room <= 0) {
        throw conflict(`${order.number} needs no more money: the payments entered already cover it.`, 'NOTHING_DUE');
    }
    const posted = await ReceiptModel.find({ buyerId: order.buyerId, status: 'POSTED' }).session(session);
    const advances = posted
        .filter((receipt) => unspentPaise(receipt) > 0)
        .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.enteredAt.getTime() - b.enteredAt.getTime());
    if (advances.length === 0) {
        throw conflict('This buyer has no advance to use.', 'NO_ADVANCE');
    }
    let left = room;
    const used = [];
    for (const receipt of advances) {
        if (left <= 0)
            break;
        const take = Math.min(left, unspentPaise(receipt));
        await ReceiptModel.updateOne({ _id: receipt._id, status: 'POSTED' }, {
            $push: {
                allocations: {
                    salesOrderId: order._id,
                    tradeId: trade._id,
                    amountPaise: take,
                    at: now,
                    by: userId,
                },
            },
        }, { session });
        used.push({ number: receipt.number, amountPaise: take });
        left -= take;
    }
    const usedPaise = room - left;
    const paidPaise = order.paidPaise + usedPaise;
    const paidInFull = paidPaise >= order.totalPaise;
    const saved = await SalesOrderModel.updateOne({ _id: order._id, version: order.version }, {
        $set: { paidPaise, ...(paidInFull ? { status: 'PAID', paidAt: now } : {}) },
        $inc: { version: 1 },
    }, { session, runValidators: true });
    if (saved.matchedCount !== 1) {
        throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
    }
    await writeAudit(req, {
        action: 'advance.use',
        entityType: 'SalesOrder',
        entityId: order.id,
        before: { orderPaidPaise: order.paidPaise },
        after: { orderPaidPaise: paidPaise, used },
        session,
    });
    return { order, usedPaise, used, paidInFull, stillDuePaise: order.totalPaise - paidPaise };
}
/** What a buyer has paid in advance and not spent yet (posted, hand-added or otherwise). */
export async function advanceOf(buyerId) {
    const posted = await ReceiptModel.find({ buyerId, status: 'POSTED' });
    const open = posted.filter((receipt) => unspentPaise(receipt) > 0);
    return {
        totalPaise: open.reduce((sum, receipt) => sum + unspentPaise(receipt), 0),
        payments: open.map((receipt) => ({
            number: receipt.number,
            utr: receipt.utr,
            receivedOn: receipt.receivedOn,
            unspentPaise: unspentPaise(receipt),
        })),
    };
}
/** Every unspent advance in the books, for the Accounts dashboard. */
export async function unspentAdvances() {
    const posted = await ReceiptModel.find({ status: 'POSTED' });
    const open = posted.filter((receipt) => unspentPaise(receipt) > 0);
    return {
        count: open.length,
        totalPaise: open.reduce((sum, receipt) => sum + unspentPaise(receipt), 0),
        buyers: new Set(open.map((receipt) => String(receipt.buyerId))).size,
    };
}
/**
 * The Accounts desk's view of advances: each buyer who has money not yet spent, his payments, and his orders that
 * are still waiting for payment (with the trade's version the engine needs). Accounts cannot open the deal card,
 * so "Use the buyer's advance" is pressed from here. Buyer side of the wall only: no seller, no rate.
 */
export async function advanceDesk() {
    const posted = await ReceiptModel.find({ status: 'POSTED' });
    const open = posted.filter((receipt) => unspentPaise(receipt) > 0);
    const buyerIds = [...new Set(open.map((receipt) => String(receipt.buyerId)))];
    const [buyers, orders] = await Promise.all([
        BuyerModel.find({ _id: { $in: buyerIds } }),
        SalesOrderModel.find({ buyerId: { $in: buyerIds }, status: 'AWAITING_PAYMENT' }).sort({
            createdAt: 1,
        }),
    ]);
    const trades = await TradeModel.find({ _id: { $in: orders.map((order) => order.tradeId) } }, { version: 1, buyerStage: 1 });
    return {
        buyers: buyers
            .map((buyer) => {
            const payments = open.filter((receipt) => String(receipt.buyerId) === buyer.id);
            return {
                buyer: { id: buyer.id, number: buyer.number, firmName: buyer.firmName },
                advancePaise: payments.reduce((sum, receipt) => sum + unspentPaise(receipt), 0),
                payments: payments.map((receipt) => ({
                    id: receipt.id,
                    number: receipt.number,
                    utr: receipt.utr,
                    receivedOn: receipt.receivedOn,
                    unspentPaise: unspentPaise(receipt),
                })),
                // Only orders at b6 can take it (the engine checks the stage too).
                orders: orders
                    .filter((order) => String(order.buyerId) === buyer.id)
                    .flatMap((order) => {
                    const trade = trades.find((item) => item._id.equals(order.tradeId));
                    if (trade?.buyerStage !== 'B6_ORDER_CONFIRMED')
                        return [];
                    return [
                        {
                            salesOrderId: order.id,
                            number: order.number,
                            tradeId: String(order.tradeId),
                            tradeVersion: trade.version,
                            totalPaise: order.totalPaise,
                            paidPaise: order.paidPaise,
                            duePaise: order.totalPaise - order.paidPaise,
                        },
                    ];
                }),
            };
        })
            .sort((a, b) => a.buyer.firmName.localeCompare(b.buyer.firmName)),
    };
}
//# sourceMappingURL=advances.js.map