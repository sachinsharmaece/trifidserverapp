import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './chain.controller.js';

export const chainRouter = Router();

// Idempotency-Key required — API_CONTRACT.md §1 — this creates a chain (moves a stage).
chainRouter.post(
  '/staff/so',
  authenticate,
  requirePermission(PERMISSIONS.SO_CREATE),
  requireIdempotencyKey(),
  controller.postCreateSo,
);

// API-084. Idempotency-Key required — moves the chain to stage 3.
chainRouter.post(
  '/staff/so/:soId/po',
  authenticate,
  requirePermission(PERMISSIONS.PO_CREATE),
  requireIdempotencyKey(),
  controller.postCreatePo,
);

chainRouter.post(
  '/staff/po/:poId/edit',
  authenticate,
  requirePermission(PERMISSIONS.PO_EDIT),
  controller.postEditPo,
);

// Q6. Idempotency-Key required — this raises a refund.
chainRouter.post(
  '/staff/so/:soId/reduce-quantity',
  authenticate,
  requirePermission(PERMISSIONS.SO_REDUCE_QUANTITY),
  requireIdempotencyKey(),
  controller.postReduceSoQuantity,
);

// API-090.
chainRouter.get(
  '/staff/chains/:id',
  authenticate,
  requirePermission(PERMISSIONS.CHAIN_READ),
  controller.getChain,
);
