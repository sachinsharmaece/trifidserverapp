import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  PurchaseOrderModel,
  SalesOrderModel,
  StockPurchaseOrderModel,
} from '../../models/index.js';
import { PURCHASE_ORDER_STATUSES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { requireAuth } from '../auth/requireAuth.js';
import { pagingShape } from '../parties/common.js';
import { canReadPurchaseOrders, purchaseOrderRow, purchaseOrderView } from './purchaseOrders.js';
import {
  canApproveStockPo,
  canRaiseStockPo,
  approveStockPo,
  createStockPo,
  payableOf,
  stockPoView,
} from './stock.js';

/**
 * Purchase orders: read only. The trade engine raises a PO when Accounts confirms that the buyer has paid in
 * full (Gate A), never here. Purchase, Accounts and the supervisors read; Sales and Logistics get 403.
 */
export const purchaseOrdersRouter: Router = Router();

purchaseOrdersRouter.use('/purchase-orders', requireAuth, canReadPurchaseOrders);

const listQuery = z.object({
  ...pagingShape,
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  /** Reference-copy screens: ALL = trade and Stock POs together, unpaged (newest 500). */
  type: z.enum(['ALL', 'TRADE', 'STOCK']).optional(),
});

/** The reference screens' list: trade POs (with their SO number and "payable?") and Stock POs, newest first. */
async function referenceList(type: 'ALL' | 'TRADE' | 'STOCK') {
  const [trade, stock] = await Promise.all([
    type === 'STOCK' ? [] : PurchaseOrderModel.find().sort({ createdAt: -1 }).limit(500),
    type === 'TRADE' ? [] : StockPurchaseOrderModel.find().sort({ createdAt: -1 }).limit(500),
  ]);
  const orders = await SalesOrderModel.find(
    { _id: { $in: trade.map((po) => po.salesOrderId) } },
    { number: 1 },
  );
  const soNumber = new Map(orders.map((so) => [so.id, so.number]));
  const rows = [
    ...trade.map((po) => ({
      ...purchaseOrderRow(po),
      type: 'TRADE' as const,
      approvalStatus: 'ISSUED' as const,
      salesOrderNumber: soNumber.get(String(po.salesOrderId)) ?? null,
      payable: payableOf(po),
    })),
    ...stock.map((po) => stockPoView(po)),
  ];
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows.slice(0, 500);
}

/**
 * GET /purchase-orders?q=&status=&page=&pageSize=  ->  { purchaseOrders, total, page, pageSize }, newest first.
 * `q` matches the PO number or the seller's number or firm name.
 */
purchaseOrdersRouter.get('/purchase-orders', async (req, res) => {
  const { q, status, page, pageSize, type } = listQuery.parse(req.query);
  if (type) {
    res.json({ purchaseOrders: await referenceList(type) });
    return;
  }
  const words = new RegExp(escapeRegex(q), 'i');
  const filter = {
    ...(q
      ? {
          $or: [
            { number: words },
            { 'sellerSnapshot.number': words },
            { 'sellerSnapshot.firmName': words },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
  };
  const [total, orders] = await Promise.all([
    PurchaseOrderModel.countDocuments(filter),
    PurchaseOrderModel.find(filter)
      .sort({ createdAt: -1, number: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  res.json({ purchaseOrders: orders.map(purchaseOrderRow), total, page, pageSize });
});

/** POST /purchase-orders { type: 'STOCK', sellerId, dispatchDueDate, lines } -> 201 { purchaseOrder } (a Stock PO). */
purchaseOrdersRouter.post('/purchase-orders', canRaiseStockPo, async (req, res) => {
  const po = await createStockPo(req);
  res.status(201).json({ purchaseOrder: stockPoView(po) });
});

/** POST /purchase-orders/:id/approve -> { purchaseOrder }: the Controller issues a Stock PO (not its maker). */
purchaseOrdersRouter.post('/purchase-orders/:id/approve', canApproveStockPo, async (req, res) => {
  const po = await approveStockPo(req, req.params.id);
  res.json({ purchaseOrder: stockPoView(po) });
});

/** GET /purchase-orders/:id  ->  { purchaseOrder } (a trade PO, or a Stock PO with type STOCK). */
purchaseOrdersRouter.get('/purchase-orders/:id', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw notFound('Purchase order not found.');
  const po = await PurchaseOrderModel.findById(req.params.id);
  if (po) {
    const so = await SalesOrderModel.findById(po.salesOrderId, {
      number: 1,
      status: 1,
      margBill: 1,
    });
    res.json({
      purchaseOrder: {
        ...(await purchaseOrderView(po)),
        type: 'TRADE',
        approvalStatus: 'ISSUED',
        salesOrderNumber: so?.number ?? null,
        payable: payableOf(po),
        // For the reference chain strip (Marg, Dispatch). Only the bill number, never buyer money.
        margBill: so?.margBill ? { invoiceNumber: so.margBill.invoiceNumber, matched: true } : null,
        leg2Dispatched: so ? ['DISPATCHED', 'DELIVERED'].includes(so.status) : false,
      },
    });
    return;
  }
  const stock = await StockPurchaseOrderModel.findById(req.params.id);
  if (!stock) throw notFound('Purchase order not found.');
  res.json({ purchaseOrder: stockPoView(stock) });
});
