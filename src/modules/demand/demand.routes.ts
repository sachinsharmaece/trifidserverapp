import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import * as controller from './demand.controller.js';

export const demandRouter = Router();

// API-040/041/042/043 — 👤B.
demandRouter.post('/asks', authenticate, controller.postAsk);
demandRouter.get('/asks', authenticate, controller.getMyAsks);
demandRouter.post(
  '/asks/:id/accept',
  authenticate,
  requireIdempotencyKey(),
  controller.postAcceptFill,
);
demandRouter.post('/asks/:id/decline', authenticate, controller.postDeclineAsk);

// API-044/045/046 — 👤S.
demandRouter.get('/demand', authenticate, controller.getDemandBoard);
demandRouter.post('/asks/:id/quotes', authenticate, controller.postQuote);
demandRouter.get('/quotes', authenticate, controller.getMyQuotes);

// API-048/049/050 — 👤S.
demandRouter.get('/confirmations', authenticate, controller.getConfirmations);
demandRouter.post(
  '/confirmations/:id/confirm',
  authenticate,
  requireIdempotencyKey(),
  controller.postConfirmPile,
);
demandRouter.post('/confirmations/:id/undo', authenticate, controller.postUndoPileConfirm);
demandRouter.post('/confirmations/:id/requote', authenticate, controller.postRequotePile);
demandRouter.post('/confirmations/:id/decline', authenticate, controller.postDeclinePile);

// API-051 — 👤S. Gated on config.claim_board (BR-140).
demandRouter.get('/claims', authenticate, controller.getClaims);
demandRouter.post('/claims/:id/claim', authenticate, controller.postClaim);
demandRouter.post('/claims/:id/undo', authenticate, controller.postUndoClaim);
