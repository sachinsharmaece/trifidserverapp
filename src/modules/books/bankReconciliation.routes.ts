import { Router } from 'express';
import { z } from 'zod';
import { BankReconciliationModel } from '../../models/index.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { objectId } from '../parties/common.js';
import {
  findReconciliation,
  markReconciled,
  reconcileInput,
  reconciliationViews,
  saveReconciliation,
} from './bankReconciliation.js';
import { banksToReconcile } from './reconciliation.js';

/**
 * Bank reconciliation (Build 9). Accounts types the closing balance from the bank statement for a day; only a
 * difference of zero can be marked reconciled, and a reconciled day is locked.
 *
 *   GET  /bank-reconciliations?bankLedgerId=   { banks, history }: each bank account's state, and past entries
 *   POST /bank-reconciliations                 { bankLedgerId, date, statementClosingPaise } → saved (OPEN)
 *   POST /bank-reconciliations/:id/mark        { version }: 409 NOT_BALANCED unless the difference is zero
 */
export const bankReconciliationRouter: Router = Router();

const READERS = ['ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const WRITERS = ['ACCOUNTS', 'FOUNDER', 'ADMIN'] as const;

bankReconciliationRouter.use('/bank-reconciliations', requireAuth, requireRole(...READERS));

bankReconciliationRouter.get('/bank-reconciliations', async (req, res) => {
  const { bankLedgerId } = z.object({ bankLedgerId: objectId.optional() }).parse(req.query);
  const history = await BankReconciliationModel.find(bankLedgerId ? { bankLedgerId } : {})
    .sort({ date: -1 })
    .limit(60);
  res.json({ banks: await banksToReconcile(), history: await reconciliationViews(history) });
});

bankReconciliationRouter.post(
  '/bank-reconciliations',
  requireRole(...WRITERS),
  async (req, res) => {
    const saved = await saveReconciliation(req, reconcileInput.parse(req.body));
    const [view] = await reconciliationViews([saved]);
    res.status(201).json({ reconciliation: view });
  },
);

bankReconciliationRouter.post(
  '/bank-reconciliations/:id/mark',
  requireRole(...WRITERS),
  async (req, res) => {
    const { version } = z.object({ version: z.number().int().min(0) }).parse(req.body);
    await markReconciled(req, await findReconciliation(String(req.params.id)), version);
    const [view] = await reconciliationViews([await findReconciliation(String(req.params.id))]);
    res.json({ reconciliation: view });
  },
);
