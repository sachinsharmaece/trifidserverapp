import { Types } from 'mongoose';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { BuyerModel, LedgerModel, ReceiptModel, SalesOrderModel, TradeModel, UserModel, VoucherModel, } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { istDate } from '../../shared/dates.js';
import { conflict, forbidden, invalidField } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { isDuplicateKeyError } from '../../shared/mongo.js';
import { buyerLedger, postVoucher } from '../books/books.js';
import { assertBankDayOpen } from '../books/reconciliation.js';
import { unspentPaise } from './allocations.js';
// Moved to shared/dates.ts so the books can use it too; other modules still import it from here.
export { istDate };
export async function openOrder({ trade, session }) {
    const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
    if (order.status !== 'AWAITING_PAYMENT') {
        throw conflict(`${order.number} is not waiting for payment.`, 'ORDER_NOT_OPEN');
    }
    return order;
}
/** Σ payments entered for the order and not yet confirmed or rejected. */
export async function waitingPaise(order, ctx) {
    const waiting = await ReceiptModel.find({ salesOrderId: order._id, status: 'LOGGED' }).session(ctx.session);
    return waiting.reduce((sum, receipt) => sum + receipt.amountPaise, 0);
}
/**
 * Sales enters what the buyer says he paid (b6). Nothing is posted: this is not money until Accounts finds it in
 * the bank. Refused: a turned-off or unknown bank account, a date in the future, a UTR already entered for that
 * bank account (SRS-PAY-03), or more than is still open on the order (total − paid − already entered).
 */
export async function logReceipt(ctx, input) {
    const { req, trade, userId, now, session } = ctx;
    const order = await openOrder(ctx);
    const bank = await LedgerModel.findById(input.bankLedgerId).session(session);
    if (!bank?.bank || !bank.active) {
        throw invalidField('bankLedgerId', 'Choose one of our bank accounts.');
    }
    if (input.receivedOn > istDate(now)) {
        throw invalidField('receivedOn', 'The date cannot be in the future.');
    }
    await assertBankDayOpen([{ ledgerId: bank._id, ledgerName: bank.name }], input.receivedOn, session);
    const same = await ReceiptModel.findOne({ bankLedgerId: bank._id, activeUtr: input.utr }).session(session);
    if (same)
        throw conflict(`UTR ${input.utr} is already entered as ${same.number}.`, 'DUPLICATE_UTR');
    const openPaise = order.totalPaise - order.paidPaise - (await waitingPaise(order, ctx));
    if (input.amountPaise > openPaise) {
        throw invalidField('amountPaise', openPaise > 0
            ? `Only ${formatRupees(openPaise)} is still to be paid on ${order.number} (payments already entered count too).`
            : `${order.number} needs no more payments: the ones entered already cover it.`);
    }
    const receipt = await ReceiptModel.create([
        {
            number: await nextDocumentNumber('RCPT', { session, at: now }),
            buyerId: trade.buyerId,
            tradeId: trade._id,
            salesOrderId: order._id,
            bankLedgerId: bank._id,
            utr: input.utr,
            activeUtr: input.utr,
            amountPaise: input.amountPaise,
            receivedOn: input.receivedOn,
            status: 'LOGGED',
            enteredBy: userId,
            enteredAt: now,
        },
    ], { session })
        .then(([created]) => created)
        .catch((error) => {
        if (isDuplicateKeyError(error)) {
            throw conflict(`UTR ${input.utr} is already entered.`, 'DUPLICATE_UTR');
        }
        throw error;
    });
    await writeAudit(req, {
        action: 'receipt.log',
        entityType: 'Receipt',
        entityId: receipt.id,
        after: { number: receipt.number, amountPaise: receipt.amountPaise, utr: receipt.utr },
        session,
    });
    return { receipt, order };
}
/** The receipt, if it belongs to this trade and still waits for Accounts; and maker ≠ checker. */
async function waitingReceipt({ trade, userId, session }, receiptId) {
    const receipt = await ReceiptModel.findById(receiptId).session(session);
    if (!receipt?.tradeId?.equals(trade._id)) {
        throw invalidField('receiptId', 'Choose a payment entered for this order.');
    }
    if (receipt.status !== 'LOGGED') {
        throw conflict(`${receipt.number} was already handled.`, 'RECEIPT_NOT_WAITING');
    }
    if (receipt.enteredBy.equals(userId)) {
        throw forbidden('You entered this payment: someone else must confirm or reject it.');
    }
    return receipt;
}
/**
 * Accounts found the money in the bank (Gate A). Posts the RECEIPT voucher (Dr our bank · Cr the buyer), marks
 * the payment POSTED and adds it to the order. `paidInFull` = the order is now PAID and the PO must be raised.
 */
export async function confirmReceipt(ctx, receiptId) {
    const { req, trade, userId, now, session } = ctx;
    const receipt = await waitingReceipt(ctx, receiptId);
    const order = await openOrder(ctx);
    const duePaise = order.totalPaise - order.paidPaise;
    if (receipt.amountPaise > duePaise) {
        throw conflict(`${receipt.number} is more than the ${formatRupees(duePaise)} still due on ${order.number}. Reject it and enter the right amount.`, 'OVERPAYMENT');
    }
    const bank = await LedgerModel.findById(receipt.bankLedgerId).session(session).orFail();
    const buyer = await BuyerModel.findById(order.buyerId).session(session).orFail();
    const buyerAccount = await buyerLedger(buyer, userId, session);
    const voucher = await postVoucher(req, {
        type: 'RECEIPT',
        date: receipt.receivedOn,
        narration: `Receipt from ${buyer.firmName} against ${order.number} · UTR ${receipt.utr}`,
        source: { type: 'RECEIPT', id: receipt._id, number: receipt.number },
        lines: [
            { ledger: bank, drPaise: receipt.amountPaise },
            { ledger: buyerAccount, crPaise: receipt.amountPaise },
        ],
        userId,
        now,
    }, session);
    const posted = await ReceiptModel.updateOne({ _id: receipt._id, status: 'LOGGED' }, {
        $set: {
            status: 'POSTED',
            postedBy: userId,
            postedAt: now,
            voucherId: voucher._id,
            // It is spent on this order in full (a bigger payment than the due is refused above).
            allocations: [
                {
                    salesOrderId: order._id,
                    tradeId: trade._id,
                    amountPaise: receipt.amountPaise,
                    at: now,
                    by: userId,
                },
            ],
        },
    }, { session });
    if (posted.matchedCount !== 1) {
        throw conflict(`${receipt.number} was already handled.`, 'RECEIPT_NOT_WAITING');
    }
    const paidPaise = order.paidPaise + receipt.amountPaise;
    const paidInFull = paidPaise >= order.totalPaise;
    const saved = await SalesOrderModel.updateOne({ _id: order._id, version: order.version }, {
        $set: { paidPaise, ...(paidInFull ? { status: 'PAID', paidAt: now } : {}) },
        $inc: { version: 1 },
    }, { session, runValidators: true });
    if (saved.matchedCount !== 1) {
        throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
    }
    await writeAudit(req, {
        action: 'receipt.post',
        entityType: 'Receipt',
        entityId: receipt.id,
        before: { status: 'LOGGED', orderPaidPaise: order.paidPaise },
        after: { status: 'POSTED', voucher: voucher.number, orderPaidPaise: paidPaise },
        session,
    });
    return {
        receipt,
        voucher,
        order,
        paidInFull,
        stillDuePaise: order.totalPaise - paidPaise,
    };
}
/** Accounts could not find the money: the entry is kept, marked REJECTED, and its UTR may be entered again. */
export async function rejectReceipt(ctx, receiptId, note) {
    const { req, userId, now, session } = ctx;
    const receipt = await waitingReceipt(ctx, receiptId);
    const result = await ReceiptModel.updateOne({ _id: receipt._id, status: 'LOGGED' }, {
        $set: { status: 'REJECTED', rejectedBy: userId, rejectedAt: now, rejectNote: note },
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
    return receipt;
}
/**
 * The payments of one order (oldest first), as the buyer side of the wall may see them: the ones entered for it, and
 * the buyer's advances spent on it. `amountPaise` is what counts for THIS order (an advance may be bigger).
 */
export async function paymentsOf(salesOrderId) {
    const receipts = await ReceiptModel.find({
        $or: [{ salesOrderId }, { 'allocations.salesOrderId': salesOrderId }],
    }).sort({ enteredAt: 1 });
    const banks = await LedgerModel.find({ _id: { $in: receipts.map((r) => r.bankLedgerId) } });
    const bankName = new Map(banks.map((bank) => [bank.id, bank.name]));
    return receipts.map((receipt) => {
        const spentHere = receipt.allocations
            .filter((item) => item.salesOrderId.equals(salesOrderId))
            .reduce((sum, item) => sum + item.amountPaise, 0);
        return {
            id: receipt.id,
            number: receipt.number,
            status: receipt.status,
            amountPaise: spentHere > 0 ? spentHere : receipt.amountPaise,
            /** The payment's full amount: more than `amountPaise` when only part of an advance went to this order. */
            receiptPaise: receipt.amountPaise,
            isAdvance: receipt.source === 'HAND_ADDED',
            utr: receipt.utr,
            bankName: bankName.get(String(receipt.bankLedgerId)) ?? '',
            receivedOn: receipt.receivedOn,
            enteredById: String(receipt.enteredBy),
            rejectNote: receipt.rejectNote ?? null,
        };
    });
}
/** One row of the Accounts queue (Payments to confirm): the buyer side only, never the seller. */
export async function paymentRows(receipts, meId, role) {
    const [buyers, orders, banks, users] = await Promise.all([
        BuyerModel.find({ _id: { $in: receipts.map((r) => r.buyerId) } }),
        SalesOrderModel.find({
            _id: { $in: receipts.flatMap((r) => (r.salesOrderId ? [r.salesOrderId] : [])) },
        }),
        LedgerModel.find({ _id: { $in: receipts.map((r) => r.bankLedgerId) } }),
        UserModel.find({ _id: { $in: receipts.map((r) => r.enteredBy) } }),
    ]);
    const [trades, vouchers] = await Promise.all([
        TradeModel.find({ _id: { $in: receipts.flatMap((r) => (r.tradeId ? [r.tradeId] : [])) } }),
        VoucherModel.find({
            _id: { $in: receipts.flatMap((r) => (r.voucherId ? [r.voucherId] : [])) },
        }),
    ]);
    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    const [buyerById, orderById, bankById, userById, tradeById, voucherById] = [
        byId(buyers),
        byId(orders),
        byId(banks),
        byId(users),
        byId(trades),
        byId(vouchers),
    ];
    return receipts.map((receipt) => {
        const order = orderById.get(String(receipt.salesOrderId));
        const buyer = buyerById.get(String(receipt.buyerId));
        return {
            id: receipt.id,
            number: receipt.number,
            status: receipt.status,
            /** SALES_ENTRY: entered by Sales against an order. HAND_ADDED: added by Accounts, an advance until spent. */
            source: receipt.source,
            note: receipt.note ?? null,
            amountPaise: receipt.amountPaise,
            /** A posted payment's advance still unspent (hand-added ones; Sales-entered ones are spent in full). */
            unspentPaise: unspentPaise(receipt),
            utr: receipt.utr,
            receivedOn: receipt.receivedOn,
            bankName: bankById.get(String(receipt.bankLedgerId))?.name ?? '',
            buyer: { number: buyer?.number ?? '', firmName: buyer?.firmName ?? '' },
            salesOrder: order
                ? {
                    id: String(receipt.salesOrderId),
                    number: order.number,
                    totalPaise: order.totalPaise,
                    paidPaise: order.paidPaise,
                }
                : null,
            enteredBy: userById.get(String(receipt.enteredBy))?.name ?? '',
            enteredAt: receipt.enteredAt,
            /** Maker ≠ checker: the person who entered it may not confirm or reject it. */
            enteredByMe: String(receipt.enteredBy) === meId,
            tradeId: receipt.tradeId ? String(receipt.tradeId) : null,
            /** The engine needs the trade's version for every press. Not used for a hand-added payment. */
            tradeVersion: receipt.tradeId ? (tradeById.get(String(receipt.tradeId))?.version ?? 0) : null,
            voucherNumber: receipt.voucherId
                ? (voucherById.get(String(receipt.voucherId))?.number ?? null)
                : null,
            rejectNote: receipt.rejectNote ?? null,
            // Supervisors may also open the deal card from the queue (a hand-added payment has none).
            canOpenTrade: role !== 'ACCOUNTS' && Boolean(receipt.tradeId),
        };
    });
}
//# sourceMappingURL=payments.js.map