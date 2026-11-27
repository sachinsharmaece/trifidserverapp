import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { PurchaseOrderModel, RefundModel, SalesOrderModel, TradeModel, } from '../../models/index.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { pagingShape } from '../parties/common.js';
import { runTradeAction } from '../trades/engine.js';
import { acceptedLines, margBillView } from './billing.js';
/**
 * The Accounts desk queue "To be billed" (Q-WF-01, Option 3: it presses the same engine action as the deal card).
 *
 *   GET  /to-be-billed?state=TO_BILL|BILLED&q=     orders checked at the dock and waiting for the Marg bill,
 *                                                   or the ones already billed (newest first)
 *   POST /to-be-billed/:salesOrderId/marg-bill      engine action recordMargBill
 *                                                   { version (the trade's), invoiceNumber, ewayBillNumber?,
 *                                                     billDate, totalPaise, lines: [{ lineNo, boxes }] }
 *
 * Buyer side of the wall (our selling price): Accounts, Controller, Founder and Admin. Accounts may press;
 * the Controller only looks.
 */
export const billingRouter = Router();
billingRouter.use('/to-be-billed', requireAuth, requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'));
/** One row: the order, the buyer, what the dock accepted at his rate, refunds due, and the bill if keyed. */
async function billingRow(order) {
    const trade = await TradeModel.findById(order.tradeId, { version: 1 });
    const refunds = await RefundModel.find({ salesOrderId: order._id, status: 'DUE' });
    return {
        salesOrderId: order.id,
        number: order.number,
        status: order.status,
        tradeId: String(order.tradeId),
        tradeVersion: trade?.version ?? null,
        buyer: { number: order.buyerSnapshot.number, firmName: order.buyerSnapshot.firmName },
        interState: order.interState,
        totalPaise: order.totalPaise,
        accepted: await acceptedLines(order),
        refundsDuePaise: refunds.reduce((sum, refund) => sum + refund.amountPaise, 0),
        margBill: margBillView(order),
    };
}
const listQuery = z.object({
    ...pagingShape,
    state: z.enum(['TO_BILL', 'BILLED']).default('TO_BILL'),
});
billingRouter.get('/to-be-billed', async (req, res) => {
    const { state, q, page, pageSize } = listQuery.parse(req.query);
    const words = new RegExp(escapeRegex(q), 'i');
    const search = q
        ? {
            $or: [
                { number: words },
                { 'buyerSnapshot.firmName': words },
                { 'margBill.invoiceNumber': words },
            ],
        }
        : {};
    let orders;
    if (state === 'TO_BILL') {
        // Paid orders whose goods the dock has checked (some accepted), oldest check first.
        const checked = await PurchaseOrderModel.find({ status: 'CHECKED' }, { salesOrderId: 1, inspectedAt: 1 }).sort({ inspectedAt: 1 });
        const found = await SalesOrderModel.find({
            _id: { $in: checked.map((po) => po.salesOrderId) },
            status: 'PAID',
            ...search,
        });
        orders = checked
            .map((po) => found.find((order) => order._id.equals(po.salesOrderId)))
            .filter((order) => Boolean(order));
    }
    else {
        orders = await SalesOrderModel.find({
            'margBill.invoiceNumber': { $exists: true },
            ...search,
        }).sort({
            'margBill.at': -1,
        });
    }
    const pageOrders = orders.slice((page - 1) * pageSize, page * pageSize);
    res.json({
        rows: await Promise.all(pageOrders.map(billingRow)),
        total: orders.length,
        page,
        pageSize,
    });
});
billingRouter.post('/to-be-billed/:salesOrderId/marg-bill', requireRole('ACCOUNTS', 'FOUNDER', 'ADMIN'), async (req, res) => {
    const id = req.params.salesOrderId;
    const order = isValidObjectId(id) ? await SalesOrderModel.findById(id) : null;
    if (!order)
        throw notFound('Order not found.');
    await runTradeAction(req, String(order.tradeId), 'recordMargBill', req.body);
    res.json({ row: await billingRow(await SalesOrderModel.findById(order._id).orFail()) });
});
//# sourceMappingURL=billing.routes.js.map