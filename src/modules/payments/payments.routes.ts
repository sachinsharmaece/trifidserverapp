import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { BuyerModel, ReceiptModel } from '../../models/index.js';
import { RECEIPT_STATUSES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { pagingShape } from '../parties/common.js';
import { runTradeAction } from '../trades/engine.js';
import { paymentRows } from './payments.js';

/**
 * The Accounts desk queue "Payments to confirm" (Q-WF-01, Option 3: a desk queue presses the SAME engine actions
 * as the deal card). Accounts, Controller, Founder and Admin read it; the engine decides who may press
 * (Accounts, Founder, Admin; never the person who entered the payment).
 */
export const paymentsRouter: Router = Router();

paymentsRouter.use(
  '/payments',
  requireAuth,
  requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'),
);

const listQuery = z.object({ ...pagingShape, status: z.enum(RECEIPT_STATUSES).default('LOGGED') });

/**
 * GET /payments?status=LOGGED&q=&page=&pageSize=  ->  { payments, total, page, pageSize }.
 * Waiting payments oldest first (a queue); confirmed and rejected ones newest first. `q` matches the payment
 * number, the UTR, or the buyer's name or number.
 */
paymentsRouter.get('/payments', async (req, res) => {
  const { q, status, page, pageSize } = listQuery.parse(req.query);
  const words = new RegExp(escapeRegex(q), 'i');
  const buyers = q
    ? await BuyerModel.find({ $or: [{ firmName: words }, { number: words }] }, { _id: 1 })
    : [];
  const filter: Record<string, unknown> = {
    status,
    ...(q
      ? {
          $or: [
            { number: words },
            { utr: new RegExp(escapeRegex(q.replace(/[\s-]/g, '')), 'i') },
            { buyerId: { $in: buyers.map((buyer) => buyer._id) } },
          ],
        }
      : {}),
  };
  const oldestFirst = status === 'LOGGED';
  const [total, receipts] = await Promise.all([
    ReceiptModel.countDocuments(filter),
    ReceiptModel.find(filter)
      .sort({ enteredAt: oldestFirst ? 1 : -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const me = currentUserOf(req);
  res.json({ payments: await paymentRows(receipts, me.id, me.role), total, page, pageSize });
});

async function findReceipt(id: string) {
  const receipt = isValidObjectId(id) ? await ReceiptModel.findById(id) : null;
  if (!receipt) throw notFound('Payment not found.');
  return receipt;
}

/** The same engine action as the deal card's button, for the trade this payment belongs to. */
async function press(
  req: Parameters<typeof runTradeAction>[0],
  id: string,
  action: 'confirmPayment' | 'rejectPayment',
  extra: Record<string, unknown>,
) {
  const receipt = await findReceipt(id);
  const body = z
    .object({ version: z.number().int().min(0) })
    .loose()
    .parse(req.body);
  await runTradeAction(req, String(receipt.tradeId), action, {
    ...extra,
    version: body.version,
    receiptId: receipt.id,
  });
  const me = currentUserOf(req);
  const [row] = await paymentRows([await findReceipt(id)], me.id, me.role);
  return row;
}

/** POST /payments/:id/confirm { version }  ->  { payment }. `version` = the trade's version (tradeVersion). */
paymentsRouter.post('/payments/:id/confirm', async (req, res) => {
  res.json({ payment: await press(req, req.params.id, 'confirmPayment', {}) });
});

/** POST /payments/:id/reject { version, note }  ->  { payment }. */
paymentsRouter.post('/payments/:id/reject', async (req, res) => {
  const { note } = z.object({ note: z.unknown() }).parse(req.body);
  res.json({ payment: await press(req, req.params.id, 'rejectPayment', { note }) });
});
