import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { SalesOrderModel } from '../../models/index.js';
import { SALES_ORDER_STATUSES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { requireAuth } from '../auth/requireAuth.js';
import { pagingShape } from '../parties/common.js';
import { canReadSalesOrders, salesOrderRow, salesOrderView } from './salesOrders.js';

/**
 * Sales orders: read only. Orders are raised and cancelled by the trade engine's actions on the deal card
 * (Q-WF-01), never here. Sales, Accounts and the supervisors may read; Purchase and Logistics get 403.
 */
export const salesOrdersRouter: Router = Router();

salesOrdersRouter.use('/sales-orders', requireAuth, canReadSalesOrders);

const listQuery = z.object({ ...pagingShape, status: z.enum(SALES_ORDER_STATUSES).optional() });

/**
 * GET /sales-orders?q=&status=&page=&pageSize=  ->  { salesOrders, total, page, pageSize }
 * Newest first. `q` matches the order number, or the buyer's number or firm name.
 */
salesOrdersRouter.get('/sales-orders', async (req, res) => {
  const { q, status, page, pageSize } = listQuery.parse(req.query);
  const words = new RegExp(escapeRegex(q), 'i');
  const filter = {
    ...(q
      ? {
          $or: [
            { number: words },
            { 'buyerSnapshot.number': words },
            { 'buyerSnapshot.firmName': words },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
  };
  const [total, orders] = await Promise.all([
    SalesOrderModel.countDocuments(filter),
    SalesOrderModel.find(filter)
      .sort({ createdAt: -1, number: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  res.json({ salesOrders: orders.map(salesOrderRow), total, page, pageSize });
});

/** GET /sales-orders/:id  ->  { salesOrder }, built for the person's role. */
salesOrdersRouter.get('/sales-orders/:id', async (req, res) => {
  const order = isValidObjectId(req.params.id)
    ? await SalesOrderModel.findById(req.params.id)
    : null;
  if (!order) throw notFound('Sales order not found.');
  res.json({ salesOrder: await salesOrderView(order, req.user!.role) });
});
