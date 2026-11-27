import { Router, type Request } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { BuyerModel, ReceiptModel, SalesOrderModel, TradeModel } from '../../models/index.js';
import { RECEIPT_STATUSES } from '../../shared/enums.js';
import { forbidden, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { pagingShape } from '../parties/common.js';
import { runTradeAction } from '../trades/engine.js';
import {
  addHandReceipt,
  advanceDesk,
  handReceiptInput,
  postHandReceipt,
  rejectHandInput,
  rejectHandReceipt,
} from './advances.js';
import { unspentPaise } from './allocations.js';
import { paymentRows } from './payments.js';

/**
 * The Accounts desk queue "Payments to confirm" (Q-WF-01, Option 3: a desk queue presses the SAME engine actions
 * as the deal card). Accounts, Controller, Founder and Admin read it; the engine decides who may press
 * (Accounts, Founder, Admin; never the person who entered the payment).
 *
 * Build 9: Accounts may also add a payment by hand when money reached the bank with no order (POST /payments/hand;
 * the buyer is picked with GET /payments/buyers).
 * A hand-added payment has no deal card, so its confirm and reject are done here, not by the engine; the rule is
 * the same (a different person posts it). Once posted it is an advance until `useAdvance` spends it on an order.
 */
export const paymentsRouter: Router = Router();

paymentsRouter.use(
  '/payments',
  requireAuth,
  requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'),
);
const WRITERS = ['ACCOUNTS', 'FOUNDER', 'ADMIN'] as const;

/** The Controller reads the queue but cannot post or reject a hand-added payment (the engine says the same for the others). */
function mustBeWriter(req: Request) {
  if (!(WRITERS as readonly string[]).includes(currentUserOf(req).role)) throw forbidden();
}

const listQuery = z.object({
  ...pagingShape,
  status: z.enum(RECEIPT_STATUSES).default('LOGGED'),
  /** true: only posted payments with an advance not yet spent. */
  unused: z.enum(['true']).optional(),
});

/**
 * GET /payments?status=LOGGED&q=&page=&pageSize=  ->  { payments, total, page, pageSize }.
 * Waiting payments oldest first (a queue); confirmed and rejected ones newest first. `q` matches the payment
 * number, the UTR, or the buyer's name or number.
 */
paymentsRouter.get('/payments', async (req, res) => {
  const { q, status, page, pageSize, unused } = listQuery.parse(req.query);
  const words = new RegExp(escapeRegex(q), 'i');
  const buyers = q
    ? await BuyerModel.find({ $or: [{ firmName: words }, { number: words }] }, { _id: 1 })
    : [];
  const filter: Record<string, unknown> = {
    status: unused ? 'POSTED' : status,
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
  const oldestFirst = status === 'LOGGED' && !unused;
  const sort = { enteredAt: oldestFirst ? (1 as const) : (-1 as const) };
  const me = currentUserOf(req);
  if (unused) {
    // Few payments are ever unspent, so the paging is done here after picking them.
    const open = (await ReceiptModel.find(filter).sort(sort)).filter(
      (receipt) => unspentPaise(receipt) > 0,
    );
    const rows = open.slice((page - 1) * pageSize, page * pageSize);
    res.json({
      payments: await paymentRows(rows, me.id, me.role),
      total: open.length,
      page,
      pageSize,
    });
    return;
  }
  const [total, receipts] = await Promise.all([
    ReceiptModel.countDocuments(filter),
    ReceiptModel.find(filter)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  res.json({ payments: await paymentRows(receipts, me.id, me.role), total, page, pageSize });
});

/**
 * POST /payments/hand { bankLedgerId, buyerId, utr, amountPaise, receivedOn, note? }  ->  201 { payment }.
 * Money that reached the bank with no order. Waits for a different person to post it. Accounts, Founder, Admin.
 */
paymentsRouter.post('/payments/hand', requireRole(...WRITERS), async (req, res) => {
  const receipt = await addHandReceipt(req, handReceiptInput.parse(req.body));
  const me = currentUserOf(req);
  const [row] = await paymentRows([receipt], me.id, me.role);
  res.status(201).json({ payment: row });
});

/**
 * GET /payments/advances  ->  { buyers: [{ buyer, advancePaise, payments[], orders[] }] }.
 * Buyers who hold money not yet spent, with their orders that are waiting for payment (the ones that can take it).
 * Accounts cannot open the deal card, so "Use the buyer's advance" is pressed from this list.
 */
paymentsRouter.get('/payments/advances', async (_req, res) => {
  res.json(await advanceDesk());
});

const buyerSearch = z.object({ q: z.string().trim().max(100).default('') });

/**
 * GET /payments/buyers?q=  ->  { buyers: [{ id, number, firmName }] }. The buyer picker of "Add a payment": active
 * buyers whose name or number matches (at least two letters), A to Z, at most 20. Accounts cannot open the Buyers
 * screen (it is Sales' side), so this list gives only what the form needs: no rates, no sellers, no contacts.
 */
paymentsRouter.get('/payments/buyers', async (req, res) => {
  const { q } = buyerSearch.parse(req.query);
  if (q.length < 2) {
    res.json({ buyers: [] });
    return;
  }
  const words = new RegExp(escapeRegex(q), 'i');
  const buyers = await BuyerModel.find(
    { active: true, $or: [{ firmName: words }, { number: words }] },
    { number: 1, firmName: 1 },
  )
    .sort({ firmName: 1 })
    .limit(20);
  res.json({
    buyers: buyers.map((buyer) => ({
      id: buyer.id,
      number: buyer.number,
      firmName: buyer.firmName,
    })),
  });
});

const useAdvanceInput = z.object({ tradeId: z.string(), version: z.number().int().min(0) });

/**
 * POST /payments/advances/use { tradeId, version }  ->  { trade: { id, buyerStage, version }, paidPaise }.
 * The SAME engine action as the deal card's "Use the buyer's advance" (oldest money first, never more than the
 * order still needs). The engine says who may press it and what is wrong if it cannot be done.
 */
paymentsRouter.post('/payments/advances/use', async (req, res) => {
  mustBeWriter(req);
  const input = useAdvanceInput.parse(req.body);
  await runTradeAction(req, input.tradeId, 'useAdvance', { version: input.version });
  const [order] = await SalesOrderModel.find({ tradeId: input.tradeId });
  const trade = await TradeModel.findById(input.tradeId, { buyerStage: 1, version: 1 });
  res.json({
    trade: { id: input.tradeId, buyerStage: trade?.buyerStage, version: trade?.version },
    order: order && {
      id: order.id,
      number: order.number,
      status: order.status,
      totalPaise: order.totalPaise,
      paidPaise: order.paidPaise,
    },
  });
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

/**
 * POST /payments/:id/confirm { version }  ->  { payment }. `version` = the trade's version (tradeVersion).
 * A hand-added payment has no trade: it needs no version, and a different person posts it as an advance.
 */
paymentsRouter.post('/payments/:id/confirm', async (req, res) => {
  const receipt = await findReceipt(req.params.id);
  if (receipt.source === 'HAND_ADDED') {
    mustBeWriter(req);
    await postHandReceipt(req, receipt.id);
    const me = currentUserOf(req);
    const [row] = await paymentRows([await findReceipt(receipt.id)], me.id, me.role);
    res.json({ payment: row });
    return;
  }
  res.json({ payment: await press(req, req.params.id, 'confirmPayment', {}) });
});

/** POST /payments/:id/reject { version, note }  ->  { payment }. */
paymentsRouter.post('/payments/:id/reject', async (req, res) => {
  const receipt = await findReceipt(req.params.id);
  if (receipt.source === 'HAND_ADDED') {
    mustBeWriter(req);
    await rejectHandReceipt(req, receipt.id, rejectHandInput.parse(req.body).note);
    const me = currentUserOf(req);
    const [row] = await paymentRows([await findReceipt(receipt.id)], me.id, me.role);
    res.json({ payment: row });
    return;
  }
  const { note } = z.object({ note: z.unknown() }).parse(req.body);
  res.json({ payment: await press(req, req.params.id, 'rejectPayment', { note }) });
});
