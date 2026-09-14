import { Router } from 'express';
import { authenticate, authenticateOptional } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './pool.controller.js';
import { poolsQuerySchema } from './pool.validation.js';

export const poolRouter = Router();

// API-060 — 👤B.
poolRouter.get('/pools', authenticate, validateQuery(poolsQuerySchema), controller.getPools);
poolRouter.get('/pools/:id', authenticateOptional, controller.getPool);

// API-061/062 — 👤B.
poolRouter.post('/pools/:id/commit', authenticate, requireIdempotencyKey(), controller.postCommit);
poolRouter.post('/pools/:id/reconfirm', authenticate, controller.postReconfirm);
poolRouter.post('/pools/:id/withdraw', authenticate, controller.postWithdraw);

// API-063 — 👤S.
poolRouter.post(
  '/pools/:id/trigger-early',
  authenticate,
  requireIdempotencyKey(),
  controller.postTriggerEarly,
);

// New — BR-158. 🏢 pool:resolve_shortfall (Purchase).
poolRouter.post(
  '/staff/pools/:id/resolve-shortfall',
  authenticate,
  requirePermission(PERMISSIONS.POOL_RESOLVE_SHORTFALL),
  controller.postResolveShortfall,
);
