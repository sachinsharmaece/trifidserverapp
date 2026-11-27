import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { BuyerModel, LedgerModel, PayoutBatchModel, PurchaseOrderModel, RefundModel, SellerModel, TradeModel, VoucherModel, } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { buyerLedger, postVoucher, sellerLedger, systemLedger } from '../books/books.js';
import { objectId } from '../parties/common.js';
import { istDate } from '../payments/payments.js';
import { savePurchaseOrder } from '../purchaseOrders/dispatch.js';
/** The freight we paid at Indore (leg 1 TO_PAY): taken off what the seller is paid. */
export const freightToTakeOff = (po) => po.leg1?.freightTerms === 'TO_PAY' ? (po.leg1.freightPaise ?? 0) : 0;
// ---------------------------------------------------------------------------------------------------------------
// What can be paid
/** A checked PO that nobody has paid or put in a batch yet, and what stops it from being paid, if anything. */
export function payableRow(po) {
    const freightPaise = freightToTakeOff(po);
    const acceptedValuePaise = po.acceptedValuePaise ?? 0;
    const netPaise = acceptedValuePaise - freightPaise;
    const waiting = po.hold
        ? `On hold: ${po.hold.reason}`
        : !po.sellerBill
            ? "Waiting for the seller's bill"
            : netPaise < 1
                ? 'The freight is more than the goods are worth'
                : null;
    return {
        id: po.id,
        number: po.number,
        seller: { number: po.sellerSnapshot.number, firmName: po.sellerSnapshot.firmName },
        acceptedBoxes: po.acceptedBoxes ?? 0,
        acceptedValuePaise,
        freightPaise,
        netPaise,
        sellerBill: po.sellerBill
            ? {
                number: po.sellerBill.number,
                amountPaise: po.sellerBill.amountPaise,
                billDate: po.sellerBill.billDate,
            }
            : null,
        inspectedAt: po.inspectedAt ?? null,
        waiting,
    };
}
/** GET /payouts/payables: checked POs and refunds due that are in no batch yet, oldest first. */
export async function payables() {
    const orders = await PurchaseOrderModel.find({
        status: 'CHECKED',
        acceptedValuePaise: { $gt: 0 },
        payoutBatchId: null,
        paidAt: null,
    }).sort({ inspectedAt: 1 });
    const refunds = await RefundModel.find({ status: 'DUE', payoutBatchId: null }).sort({
        createdAt: 1,
    });
    const buyers = await BuyerModel.find({ _id: { $in: refunds.map((refund) => refund.buyerId) } }, { number: 1, firmName: 1 });
    return {
        purchaseOrders: orders.map(payableRow),
        refunds: refunds.map((refund) => {
            const buyer = buyers.find((item) => item._id.equals(refund.buyerId));
            return {
                id: refund.id,
                number: refund.number,
                buyer: { number: buyer?.number ?? '', firmName: buyer?.firmName ?? '' },
                reason: refund.reason,
                boxes: refund.boxes,
                amountPaise: refund.amountPaise,
                createdAt: refund.createdAt,
            };
        }),
    };
}
// ---------------------------------------------------------------------------------------------------------------
// Build and cancel
export const buildInput = z
    .object({
    bankLedgerId: objectId,
    purchaseOrderIds: z.array(objectId).max(100).default([]),
    refundIds: z.array(objectId).max(100).default([]),
})
    .refine((input) => input.purchaseOrderIds.length + input.refundIds.length > 0, {
    message: 'Choose at least one payment.',
    path: ['purchaseOrderIds'],
});
/** A seller line for a PO that may be paid now; claims the PO for the batch. */
async function sellerLine(poId, batchId, session) {
    const po = await PurchaseOrderModel.findById(poId).session(session);
    if (!po)
        throw invalidField('purchaseOrderIds', 'Purchase order not found.');
    if (po.paidAt)
        throw conflict(`${po.number} is already paid.`, 'ALREADY_PAID');
    if (po.payoutBatchId) {
        throw conflict(`${po.number} is already in a payout batch.`, 'ALREADY_IN_BATCH');
    }
    const acceptedValuePaise = po.acceptedValuePaise ?? 0;
    if (po.status !== 'CHECKED' || acceptedValuePaise < 1) {
        throw conflict(`${po.number} has not passed the dock check.`, 'NOT_PAYABLE');
    }
    if (po.hold) {
        throw conflict(`${po.number} is on hold: ${po.hold.reason}`, 'ON_HOLD');
    }
    if (!po.sellerBill) {
        throw conflict(`${po.number}: the seller's bill is not on file yet.`, 'NO_SELLER_BILL');
    }
    const trade = await TradeModel.findById(po.tradeId, { sellerStage: 1 }).session(session);
    if (trade?.sellerStage !== 'S6_PAYMENT') {
        throw conflict(`${po.number} is not waiting to be paid.`, 'NOT_PAYABLE');
    }
    const freightPaise = freightToTakeOff(po);
    if (acceptedValuePaise - freightPaise < 1) {
        throw invalidField('purchaseOrderIds', `${po.number}: the freight (${formatRupees(freightPaise)}) is more than the goods are worth.`);
    }
    const claim = await PurchaseOrderModel.updateOne({ _id: po._id, payoutBatchId: null, paidAt: null }, { $set: { payoutBatchId: batchId } }, { session });
    if (claim.matchedCount !== 1) {
        throw conflict(`${po.number} was just put in another batch.`, 'ALREADY_IN_BATCH');
    }
    return {
        type: 'PAYOUT',
        purchaseOrderId: po._id,
        tradeId: po.tradeId,
        reference: po.number,
        payee: { number: po.sellerSnapshot.number, firmName: po.sellerSnapshot.firmName },
        grossPaise: acceptedValuePaise,
        freightPaise,
        amountPaise: acceptedValuePaise - freightPaise,
        status: 'DRAFT',
    };
}
/** A buyer line for a refund that is due; claims the refund for the batch. */
async function refundLine(refundId, batchId, session) {
    const refund = await RefundModel.findById(refundId).session(session);
    if (!refund)
        throw invalidField('refundIds', 'Refund not found.');
    if (refund.status !== 'DUE')
        throw conflict(`${refund.number} is already paid.`, 'ALREADY_PAID');
    if (refund.payoutBatchId) {
        throw conflict(`${refund.number} is already in a payout batch.`, 'ALREADY_IN_BATCH');
    }
    const buyer = await BuyerModel.findById(refund.buyerId).session(session).orFail();
    const claim = await RefundModel.updateOne({ _id: refund._id, status: 'DUE', payoutBatchId: null }, { $set: { payoutBatchId: batchId } }, { session });
    if (claim.matchedCount !== 1) {
        throw conflict(`${refund.number} was just put in another batch.`, 'ALREADY_IN_BATCH');
    }
    return {
        type: 'REFUND',
        refundId: refund._id,
        tradeId: refund.tradeId,
        reference: refund.number,
        payee: { number: buyer.number, firmName: buyer.firmName },
        grossPaise: refund.amountPaise,
        freightPaise: 0,
        amountPaise: refund.amountPaise,
        status: 'DRAFT',
    };
}
/** Build a DRAFT batch from the chosen POs and refunds, all in one transaction. */
export async function buildBatch(req, input) {
    const userId = new Types.ObjectId(currentUserOf(req).id);
    const now = new Date();
    const batchId = new Types.ObjectId();
    return mongoose.connection.transaction(async (session) => {
        const bank = await LedgerModel.findById(input.bankLedgerId).session(session);
        if (!bank?.bank || !bank.active) {
            throw invalidField('bankLedgerId', 'Choose one of our bank accounts.');
        }
        const lines = [];
        for (const id of new Set(input.purchaseOrderIds))
            lines.push(await sellerLine(id, batchId, session));
        for (const id of new Set(input.refundIds))
            lines.push(await refundLine(id, batchId, session));
        const totalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
        const [batch] = await PayoutBatchModel.create([
            {
                _id: batchId,
                number: await nextDocumentNumber('PAYB', { session, at: now }),
                bankLedgerId: bank._id,
                lines,
                totalPaise,
                createdBy: userId,
            },
        ], { session });
        if (!batch)
            throw new Error('The payout batch was not created');
        await writeAudit(req, {
            action: 'payoutBatch.build',
            entityType: 'PayoutBatch',
            entityId: batch.id,
            after: { number: batch.number, lines: lines.length, totalPaise },
            session,
        });
        return batch;
    });
}
/** Load a batch or 404. */
export async function findBatch(id) {
    const batch = Types.ObjectId.isValid(id) ? await PayoutBatchModel.findById(id) : null;
    if (!batch)
        throw notFound('Payout batch not found.');
    return batch;
}
function checkVersion(batch, version) {
    if (batch.version !== version) {
        throw conflict('Someone else changed this batch. Reload and try again.', 'STALE_BATCH');
    }
}
/** Cancel a DRAFT batch and let go of its POs and refunds. */
export async function cancelBatch(req, batch, version) {
    checkVersion(batch, version);
    if (batch.status !== 'DRAFT') {
        throw conflict('Only a batch that has not been released can be cancelled.', 'NOT_DRAFT');
    }
    const userId = new Types.ObjectId(currentUserOf(req).id);
    await mongoose.connection.transaction(async (session) => {
        const result = await PayoutBatchModel.updateOne({ _id: batch._id, version: batch.version }, {
            $set: { status: 'CANCELLED', cancelledBy: userId, cancelledAt: new Date() },
            $inc: { version: 1 },
        }, { session });
        if (result.matchedCount !== 1) {
            throw conflict('Someone else changed this batch. Reload and try again.', 'STALE_BATCH');
        }
        await PurchaseOrderModel.updateMany({ payoutBatchId: batch._id }, { $unset: { payoutBatchId: 1 } }, { session });
        await RefundModel.updateMany({ payoutBatchId: batch._id }, { $unset: { payoutBatchId: 1 } }, { session });
        await writeAudit(req, {
            action: 'payoutBatch.cancel',
            entityType: 'PayoutBatch',
            entityId: batch.id,
            after: { number: batch.number },
            session,
        });
    });
}
/**
 * Release a DRAFT batch (Founder or Admin, after the password re-check; the route asks for that). Maker ≠ checker:
 * the person who built it may not release it, whatever their role. Every line is now waiting for the bank proof.
 */
export async function releaseBatch(req, batch, version) {
    checkVersion(batch, version);
    if (batch.status !== 'DRAFT') {
        throw conflict('This batch is not waiting for release.', 'NOT_DRAFT');
    }
    const userId = new Types.ObjectId(currentUserOf(req).id);
    if (batch.createdBy.equals(userId)) {
        throw forbidden('You built this batch, so someone else must release it (maker and checker are different people).');
    }
    const lines = batch.lines.map((line) => ({ ...line.toObject(), status: 'PROOF_PENDING' }));
    const result = await PayoutBatchModel.updateOne({ _id: batch._id, version: batch.version }, {
        $set: { status: 'RELEASED', releasedBy: userId, releasedAt: new Date(), lines },
        $inc: { version: 1 },
    }, { runValidators: true });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this batch. Reload and try again.', 'STALE_BATCH');
    }
    await writeAudit(req, {
        action: 'payoutBatch.release',
        entityType: 'PayoutBatch',
        entityId: batch.id,
        after: { number: batch.number, totalPaise: batch.totalPaise },
    });
}
// ---------------------------------------------------------------------------------------------------------------
// The bank proof
/** A bank reference: letters and digits, spaces and dashes removed, capitals (as for a buyer's payment). */
export const proofFields = z.object({
    utr: z
        .string()
        .transform((text) => text.replace(/[\s-]/g, '').toUpperCase())
        .pipe(z.string().regex(/^[0-9A-Z]{6,30}$/, 'A UTR has 6 to 30 letters or digits.')),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date it was paid.'),
});
/** The engine action's input: the proof for one line of one batch. */
export const sellerPaymentInput = proofFields.extend({ batchId: objectId, lineId: objectId });
/** The batch must be RELEASED and the line waiting for its proof; the date may not be in the future. */
function checkProofAllowed(batch, line, input, now) {
    if (batch.status !== 'RELEASED') {
        throw conflict(`${batch.number} has not been released.`, 'NOT_RELEASED');
    }
    if (line.status !== 'PROOF_PENDING') {
        throw conflict(`${line.reference} is already paid.`, 'ALREADY_PAID');
    }
    if (input.paidOn > istDate(now))
        throw invalidField('paidOn', 'The date cannot be in the future.');
}
/** Write the line as PAID (with its proof and voucher) into the batch, in the caller's transaction. */
async function markLinePaid(req, batch, line, proof, session) {
    const lines = batch.lines.map((item) => item._id.equals(line._id)
        ? {
            ...item.toObject(),
            status: 'PAID',
            voucherId: proof.voucherId,
            proof: {
                utr: proof.input.utr,
                paidOn: proof.input.paidOn,
                by: proof.userId,
                at: proof.now,
            },
        }
        : item.toObject());
    const result = await PayoutBatchModel.updateOne({ _id: batch._id, version: batch.version }, { $set: { lines }, $inc: { version: 1 } }, { session, runValidators: true });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this batch. Reload and try again.', 'STALE_BATCH');
    }
    await writeAudit(req, {
        action: 'payoutBatch.proof',
        entityType: 'PayoutBatch',
        entityId: batch.id,
        after: { number: batch.number, reference: line.reference, utr: proof.input.utr },
        session,
    });
}
/**
 * The engine action `recordSellerPayment` (s6 → Closed): the UTR for a seller's line. Posts the PAYMENT voucher
 * (Dr the seller for what we owed · Cr our bank for what left it · Cr Freight for the freight we paid at Indore),
 * marks the line and the PO paid. The seller side of the trade is closed.
 */
export async function recordSellerPayment(ctx, input) {
    const { req, trade, userId, now, session } = ctx;
    const batch = await PayoutBatchModel.findById(input.batchId).session(session);
    const line = batch?.lines.find((item) => item._id.equals(input.lineId));
    if (!batch || !line)
        throw notFound('That payout line was not found.');
    if (line.type !== 'PAYOUT' || !line.tradeId.equals(trade._id) || !line.purchaseOrderId) {
        throw conflict('That payout line is not for this deal.', 'WRONG_LINE');
    }
    checkProofAllowed(batch, line, input, now);
    const po = await PurchaseOrderModel.findById(line.purchaseOrderId).session(session).orFail();
    const seller = await SellerModel.findById(po.sellerId).session(session).orFail();
    const bank = await LedgerModel.findById(batch.bankLedgerId).session(session).orFail();
    const payee = await sellerLedger(seller, userId, session);
    const voucher = await postVoucher(req, {
        type: 'PAYMENT',
        date: input.paidOn,
        narration: `Paid ${seller.firmName} for ${po.number} · UTR ${input.utr} (${batch.number})`,
        source: { type: 'PAYOUT_LINE', id: line._id, number: batch.number },
        lines: [
            { ledger: payee, drPaise: line.grossPaise },
            { ledger: bank, crPaise: line.amountPaise },
            ...(line.freightPaise > 0
                ? [{ ledger: await systemLedger('FREIGHT', userId, session), crPaise: line.freightPaise }]
                : []),
        ],
        userId,
        now,
    }, session);
    await markLinePaid(req, batch, line, { input, voucherId: voucher._id, userId, now }, session);
    await savePurchaseOrder(ctx, po, { paidAt: now }, {
        action: 'purchaseOrder.paid',
        after: { paid: true, batch: batch.number, utr: input.utr, amountPaise: line.amountPaise },
    });
    const freight = line.freightPaise > 0 ? ` after ${formatRupees(line.freightPaise)} freight paid at Indore` : '';
    return {
        note: `Seller paid ${formatRupees(line.amountPaise)}${freight}: UTR ${input.utr}, ${input.paidOn} (${voucher.number}). Closed`,
    };
}
/** A refund line's proof: Dr the buyer · Cr our bank; the refund is PAID. Not a trade action (no stage moves). */
export async function payRefundLine(req, batchId, lineId, input) {
    const userId = new Types.ObjectId(currentUserOf(req).id);
    const now = new Date();
    await mongoose.connection.transaction(async (session) => {
        const batch = await PayoutBatchModel.findById(batchId).session(session).orFail();
        const line = batch.lines.find((item) => item._id.equals(lineId));
        if (!line || line.type !== 'REFUND' || !line.refundId) {
            throw notFound('That payout line was not found.');
        }
        checkProofAllowed(batch, line, input, now);
        const refund = await RefundModel.findById(line.refundId).session(session).orFail();
        const buyer = await BuyerModel.findById(refund.buyerId).session(session).orFail();
        const bank = await LedgerModel.findById(batch.bankLedgerId).session(session).orFail();
        const payee = await buyerLedger(buyer, userId, session);
        const voucher = await postVoucher(req, {
            type: 'PAYMENT',
            date: input.paidOn,
            narration: `Refund ${refund.number} to ${buyer.firmName} · UTR ${input.utr} (${batch.number})`,
            source: { type: 'PAYOUT_LINE', id: line._id, number: batch.number },
            lines: [
                { ledger: payee, drPaise: line.amountPaise },
                { ledger: bank, crPaise: line.amountPaise },
            ],
            userId,
            now,
        }, session);
        await markLinePaid(req, batch, line, { input, voucherId: voucher._id, userId, now }, session);
        await RefundModel.updateOne({ _id: refund._id, status: 'DUE' }, { $set: { status: 'PAID', paidAt: now } }, { session });
        await writeAudit(req, {
            action: 'refund.pay',
            entityType: 'Refund',
            entityId: refund.id,
            before: { status: 'DUE' },
            after: { status: 'PAID', utr: input.utr, amountPaise: line.amountPaise },
            session,
        });
    });
}
// ---------------------------------------------------------------------------------------------------------------
// Views
/** One line as the cards show it: where it is in the payout and, once paid, its proof. */
function lineFacts(batch, line) {
    return {
        batchNumber: batch.number,
        status: line.status,
        grossPaise: line.grossPaise,
        freightPaise: line.freightPaise,
        amountPaise: line.amountPaise,
        utr: line.proof?.utr ?? null,
        paidOn: line.proof?.paidOn ?? null,
    };
}
/** The payout of a PO (seller side): null until a batch takes it. */
export async function payoutOfPo(po) {
    if (!po.payoutBatchId)
        return null;
    const batch = await PayoutBatchModel.findById(po.payoutBatchId);
    const line = batch?.lines.find((item) => item.purchaseOrderId?.equals(po._id));
    return batch && line ? lineFacts(batch, line) : null;
}
/** The payouts of some refunds (buyer side), by refund id. */
export async function payoutsOfRefunds(refunds) {
    const ids = refunds.flatMap((refund) => (refund.payoutBatchId ? [refund.payoutBatchId] : []));
    const batches = ids.length ? await PayoutBatchModel.find({ _id: { $in: ids } }) : [];
    const byRefund = new Map();
    for (const batch of batches) {
        for (const line of batch.lines) {
            if (line.refundId)
                byRefund.set(String(line.refundId), lineFacts(batch, line));
        }
    }
    return byRefund;
}
/** A batch for the Payouts screen: its lines with payees, the bank, and what only the viewer needs to know. */
export async function batchView(batch, viewerId) {
    const bank = await LedgerModel.findById(batch.bankLedgerId, { name: 1 });
    const voucherIds = batch.lines.flatMap((line) => (line.voucherId ? [line.voucherId] : []));
    const vouchers = voucherIds.length
        ? await VoucherModel.find({ _id: { $in: voucherIds } }, { number: 1 })
        : [];
    return {
        id: batch.id,
        number: batch.number,
        status: batch.status,
        version: batch.version,
        bankName: bank?.name ?? '',
        totalPaise: batch.totalPaise,
        createdAt: batch.createdAt,
        releasedAt: batch.releasedAt ?? null,
        /** Maker ≠ checker: the builder may not release it. */
        builtByMe: String(batch.createdBy) === viewerId,
        paidCount: batch.lines.filter((line) => line.status === 'PAID').length,
        lines: batch.lines.map((line) => ({
            id: String(line._id),
            type: line.type,
            reference: line.reference,
            payee: { number: line.payee.number, firmName: line.payee.firmName },
            grossPaise: line.grossPaise,
            freightPaise: line.freightPaise,
            amountPaise: line.amountPaise,
            status: line.status,
            utr: line.proof?.utr ?? null,
            paidOn: line.proof?.paidOn ?? null,
            voucherNumber: line.voucherId
                ? (vouchers.find((voucher) => voucher._id.equals(line.voucherId))?.number ?? null)
                : null,
        })),
    };
}
//# sourceMappingURL=payouts.js.map