import { Router } from 'express';
import { z } from 'zod';
import { PayoutBatchModel, TradeModel } from '../../models/index.js';
import { PAYOUT_BATCH_STATUSES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { requireStepUp } from '../auth/stepUp.js';
import { pagingShape } from '../parties/common.js';
import { runTradeAction } from '../trades/engine.js';
import { batchView, buildBatch, buildInput, cancelBatch, findBatch, payables, payRefundLine, proofFields, releaseBatch, } from './payouts.js';
/**
 * Payouts: money out of our bank, for sellers (the goods the dock accepted) and for refunds due to buyers.
 *
 *   GET  /payouts/payables                       checked POs and refunds due that are in no batch yet
 *   GET  /payout-batches?status=&q=              batches, newest first (default DRAFT)
 *   POST /payout-batches                         build one: { bankLedgerId, purchaseOrderIds[], refundIds[] } → 201
 *   POST /payout-batches/:id/release             { version }: Founder or Admin, not the builder; password re-check
 *   POST /payout-batches/:id/cancel              { version }: only while DRAFT
 *   POST /payout-batches/:id/lines/:lineId/proof { utr, paidOn }: the bank proof for one line
 *
 * A batch names sellers and buyers, so only the Accounts desk and the supervisors see it. Accounts builds and
 * types the proofs; Founder and Admin release (and may do everything); the Controller only looks (Q-ROL-01).
 * A seller's line is the engine action `recordSellerPayment` (it closes the seller side of the deal).
 */
export const payoutsRouter = Router();
const READERS = ['ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'];
const WRITERS = ['ACCOUNTS', 'FOUNDER', 'ADMIN'];
payoutsRouter.use(['/payouts', '/payout-batches'], requireAuth, requireRole(...READERS));
payoutsRouter.get('/payouts/payables', async (_req, res) => {
    res.json(await payables());
});
const listQuery = z.object({
    ...pagingShape,
    status: z.enum(PAYOUT_BATCH_STATUSES).default('DRAFT'),
});
payoutsRouter.get('/payout-batches', async (req, res) => {
    const { status, q, page, pageSize } = listQuery.parse(req.query);
    const words = new RegExp(escapeRegex(q), 'i');
    const filter = {
        status,
        ...(q ? { $or: [{ number: words }, { 'lines.payee.firmName': words }] } : {}),
    };
    const [batches, total] = await Promise.all([
        PayoutBatchModel.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize),
        PayoutBatchModel.countDocuments(filter),
    ]);
    const me = currentUserOf(req).id;
    res.json({
        batches: await Promise.all(batches.map((batch) => batchView(batch, me))),
        total,
        page,
        pageSize,
    });
});
payoutsRouter.post('/payout-batches', requireRole(...WRITERS), async (req, res) => {
    const batch = await buildBatch(req, buildInput.parse(req.body));
    res.status(201).json({ batch: await batchView(batch, currentUserOf(req).id) });
});
const versionBody = z.object({ version: z.number().int().min(0) });
payoutsRouter.post('/payout-batches/:id/release', requireRole('FOUNDER', 'ADMIN'), requireStepUp, async (req, res) => {
    const id = String(req.params.id);
    await releaseBatch(req, await findBatch(id), versionBody.parse(req.body).version);
    res.json({ batch: await batchView(await findBatch(id), currentUserOf(req).id) });
});
payoutsRouter.post('/payout-batches/:id/cancel', requireRole(...WRITERS), async (req, res) => {
    const batch = await findBatch(req.params.id);
    await cancelBatch(req, batch, versionBody.parse(req.body).version);
    res.json({ batch: await batchView(await findBatch(req.params.id), currentUserOf(req).id) });
});
payoutsRouter.post('/payout-batches/:id/lines/:lineId/proof', requireRole(...WRITERS), async (req, res) => {
    const batch = await findBatch(req.params.id);
    const line = batch.lines.find((item) => String(item._id) === req.params.lineId);
    if (!line)
        throw notFound('That payout line was not found.');
    if (line.type === 'REFUND') {
        await payRefundLine(req, batch._id, line._id, proofFields.parse(req.body));
    }
    else {
        // The engine wants the trade's version; the line's own state (PROOF_PENDING) stops a double press.
        const trade = await TradeModel.findById(line.tradeId, { version: 1 }).orFail();
        await runTradeAction(req, String(line.tradeId), 'recordSellerPayment', {
            ...req.body,
            version: trade.version,
            batchId: String(batch._id),
            lineId: String(line._id),
        });
    }
    res.json({ batch: await batchView(await findBatch(req.params.id), currentUserOf(req).id) });
});
//# sourceMappingURL=payouts.routes.js.map