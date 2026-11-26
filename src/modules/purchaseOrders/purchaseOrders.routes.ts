import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { PurchaseOrderModel } from '../../models/index.js';
import { PURCHASE_ORDER_STATUSES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { requireAuth } from '../auth/requireAuth.js';
import { pagingShape } from '../parties/common.js';
import { canReadPurchaseOrders, purchaseOrderRow, purchaseOrderView } from './purchaseOrders.js';

/**
 * Purchase orders: read only. The trade engine raises a PO when Accounts confirms that the buyer has paid in
 * full (Gate A), never here. Purchase, Accounts and the supervisors read; Sales and Logistics get 403.
 */
export const purchaseOrdersRouter: Router = Router();

purchaseOrdersRouter.use('/purchase-orders', requireAuth, canReadPurchaseOrders);

const listQuery = z.object({
  ...pagingShape,
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
});

/**
 * GET /purchase-orders?q=&status=&page=&pageSize=  ->  { purchaseOrders, total, page, pageSize }, newest first.
 * `q` matches the PO number or the seller's number or firm name.
 */
purchaseOrdersRouter.get('/purchase-orders', async (req, res) => {
  const { q, status, page, pageSize } = listQuery.parse(req.query);
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

/** GET /purchase-orders/:id  ->  { purchaseOrder } */
purchaseOrdersRouter.get('/purchase-orders/:id', async (req, res) => {
  const po = isValidObjectId(req.params.id)
    ? await PurchaseOrderModel.findById(req.params.id)
    : null;
  if (!po) throw notFound('Purchase order not found.');
  res.json({ purchaseOrder: await purchaseOrderView(po) });
});
