import { Router } from 'express';
import { z } from 'zod';
import { CreditEditModel, CreditRequestModel, BuyerModel, UserModel } from '../../models/index.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import {
  approveRequest,
  checkEdit,
  checkInput,
  createRequest,
  editInput,
  exposureSummaries,
  getCredit,
  proposeEdit,
  rejectRequest,
  requestInput,
  requestsToApprove,
  requestViews,
  runCheck,
  runDailyCreditJob,
} from './credit.js';

/**
 * Credit (reference FAST-ORDER LOCK-42 Part C). Buyer side of the wall: Sales, Accounts and the supervisors.
 *
 *   GET  /credit/card?buyerId=                     the credit card (one formula for every screen)
 *   POST /credit/requests/check                    { buyerId, toLimitPaise, days, referenceMobile } → the checks (dry run)
 *   POST /credit/requests                          … + referenceName, note?  → 201 { request }  (refused on a Stop)
 *   GET  /credit/requests?scope=toApprove|mine&buyerId=
 *   POST /credit/requests/:id/approve | /reject { reason }
 *   GET  /credit/edits?buyerId=&status=            Accounts' changes to a line
 *   POST /credit/edits                             { buyerId, kind, newValue, reason } → 201
 *   POST /credit/edits/:id/check                   { apply }: a second person
 *   GET  /credit/exposure                          exposure by executive and by reference (Controller)
 *   POST /credit/run-daily                         the daily job now (it also runs once a day by itself)
 */
export const creditRouter: Router = Router();

const BUYER_SIDE = ['SALES', 'ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const REQUESTERS = ['SALES', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const EDITORS = ['ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const SUPERVISORS = ['CONTROLLER', 'FOUNDER', 'ADMIN'] as const;

creditRouter.use('/credit', requireAuth, requireRole(...BUYER_SIDE));

const buyerQuery = z.object({ buyerId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a buyer') });

creditRouter.get('/credit/card', async (req, res) => {
  const { buyerId } = buyerQuery.parse(req.query);
  res.json({ card: await getCredit(buyerId) });
});

creditRouter.post('/credit/requests/check', requireRole(...REQUESTERS), async (req, res) => {
  res.json({ result: await runCheck(req, checkInput.parse(req.body)) });
});

creditRouter.post('/credit/requests', requireRole(...REQUESTERS), async (req, res) => {
  const request = await createRequest(req, requestInput.parse(req.body));
  const [view] = await requestViews([request]);
  res.status(201).json({ request: view });
});

const listQuery = z.object({
  scope: z.enum(['toApprove', 'mine', 'party']).default('toApprove'),
  buyerId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
});

creditRouter.get('/credit/requests', async (req, res) => {
  const { scope, buyerId } = listQuery.parse(req.query);
  const me = currentUserOf(req);
  const requests =
    scope === 'toApprove'
      ? await requestsToApprove(req)
      : await CreditRequestModel.find({
          ...(scope === 'mine' ? { requestedBy: me.id } : {}),
          ...(buyerId ? { buyerId } : {}),
        })
          .sort({ createdAt: -1 })
          .limit(100);
  res.json({ requests: await requestViews(requests) });
});

creditRouter.post('/credit/requests/:id/approve', requireRole(...REQUESTERS), async (req, res) => {
  const request = await approveRequest(req, String(req.params.id));
  const [view] = await requestViews([request]);
  res.json({ request: view });
});

creditRouter.post('/credit/requests/:id/reject', requireRole(...REQUESTERS), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().default('') }).parse(req.body);
  const request = await rejectRequest(req, String(req.params.id), reason);
  const [view] = await requestViews([request]);
  res.json({ request: view });
});

const editsQuery = z.object({
  buyerId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  status: z.enum(['PENDING', 'APPLIED', 'REJECTED']).optional(),
});

creditRouter.get('/credit/edits', requireRole(...EDITORS), async (req, res) => {
  const query = editsQuery.parse(req.query);
  const edits = await CreditEditModel.find({
    ...(query.buyerId ? { buyerId: query.buyerId } : {}),
    ...(query.status ? { status: query.status } : {}),
  })
    .sort({ createdAt: 1 })
    .limit(200);
  const [buyers, users] = await Promise.all([
    BuyerModel.find({ _id: { $in: edits.map((e) => e.buyerId) } }),
    UserModel.find({ _id: { $in: edits.map((e) => e.madeBy) } }),
  ]);
  const me = currentUserOf(req).id;
  res.json({
    edits: edits.map((edit) => ({
      id: edit.id,
      party: {
        id: String(edit.buyerId),
        name: buyers.find((b) => b._id.equals(edit.buyerId))?.firmName ?? '',
      },
      kind: edit.kind,
      oldValue: edit.oldValue,
      newValue: edit.newValue,
      reason: edit.reason,
      madeBy: users.find((u) => u._id.equals(edit.madeBy))?.name ?? '',
      madeByMe: edit.madeBy.equals(me),
      status: edit.status,
      createdAt: edit.createdAt,
    })),
  });
});

creditRouter.post('/credit/edits', requireRole(...EDITORS), async (req, res) => {
  const edit = await proposeEdit(req, editInput.parse(req.body));
  res.status(201).json({ edit: { id: edit.id, status: edit.status } });
});

creditRouter.post('/credit/edits/:id/check', requireRole(...EDITORS), async (req, res) => {
  const { apply } = z.object({ apply: z.boolean() }).parse(req.body);
  const edit = await checkEdit(req, String(req.params.id), apply);
  res.json({ edit: { id: edit.id, status: edit.status } });
});

creditRouter.get('/credit/exposure', requireRole(...SUPERVISORS), async (_req, res) => {
  res.json(await exposureSummaries());
});

creditRouter.post('/credit/run-daily', requireRole(...SUPERVISORS), async (_req, res) => {
  res.json(await runDailyCreditJob());
});
