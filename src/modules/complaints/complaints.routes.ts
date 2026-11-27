import { Router } from 'express';
import { z } from 'zod';
import { BuyerModel, ComplaintModel, SalesOrderModel, TradeModel } from '../../models/index.js';
import { COMPLAINT_STATUSES } from '../../shared/enums.js';
import { escapeRegex } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { pagingShape } from '../parties/common.js';
import { BUYER_SIDE_ROLES } from '../parties/permissions.js';
import { complaintViews } from './complaints.js';

/**
 * Complaints (buyer side of the wall, Build 6). The routes only READ: a complaint is raised and resolved by the
 * trade engine's actions `raiseComplaint` and `resolveComplaint` (Q-WF-01), from the deal card or this list.
 *
 *   GET /complaints?status=OPEN|RESOLVED&q=&page=&pageSize=   the Controller's queue (Sales sees the same list)
 */
export const complaintsRouter: Router = Router();

complaintsRouter.use('/complaints', requireAuth, requireRole(...BUYER_SIDE_ROLES));

const listQuery = z.object({ ...pagingShape, status: z.enum(COMPLAINT_STATUSES).default('OPEN') });

complaintsRouter.get('/complaints', async (req, res) => {
  const { status, q, page, pageSize } = listQuery.parse(req.query);
  const filter: Record<string, unknown> = { status };
  if (q) {
    const buyers = await BuyerModel.find({
      firmKey: { $regex: escapeRegex(normaliseKey(q)) },
    }).select('_id');
    filter.$or = [
      { number: { $regex: escapeRegex(q.toUpperCase()) } },
      { buyerId: { $in: buyers.map((buyer) => buyer._id) } },
    ];
  }
  const counts = {
    OPEN: await ComplaintModel.countDocuments({ status: 'OPEN' }),
    RESOLVED: await ComplaintModel.countDocuments({ status: 'RESOLVED' }),
  };
  const found = await ComplaintModel.find(filter);
  // The queue: who has waited longest first. Decided ones: the newest decision first.
  found.sort((a, b) =>
    status === 'OPEN'
      ? a.raisedAt.getTime() - b.raisedAt.getTime()
      : (b.resolution?.at.getTime() ?? 0) - (a.resolution?.at.getTime() ?? 0),
  );
  const pageOf = found.slice((page - 1) * pageSize, page * pageSize);

  const views = await complaintViews(pageOf);
  const buyers = await BuyerModel.find(
    { _id: { $in: pageOf.map((item) => item.buyerId) } },
    { number: 1, firmName: 1 },
  );
  const orders = await SalesOrderModel.find(
    { _id: { $in: pageOf.map((item) => item.salesOrderId) } },
    { number: 1 },
  );
  const trades = await TradeModel.find(
    { _id: { $in: pageOf.map((item) => item.tradeId) } },
    { number: 1, version: 1 },
  );
  const complaints = views.map((view, index) => {
    const item = pageOf[index]!;
    const buyer = buyers.find((b) => b._id.equals(item.buyerId));
    const trade = trades.find((t) => t._id.equals(item.tradeId));
    return {
      ...view,
      buyer: { number: buyer?.number ?? '', firmName: buyer?.firmName ?? '' },
      salesOrder: {
        id: String(item.salesOrderId),
        number: orders.find((o) => o._id.equals(item.salesOrderId))?.number ?? '',
      },
      trade: {
        id: String(item.tradeId),
        number: trade?.number ?? '',
        version: trade?.version ?? 0,
      },
    };
  });
  res.json({ counts, complaints, total: found.length, page, pageSize });
});
