import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './marg.controller.js';

export const margRouter = Router();

// API-088 — 🏢 marg:key. Idempotency-Key required — books money and moves the chain.
margRouter.post(
  '/staff/marg/:soId',
  authenticate,
  requirePermission(PERMISSIONS.MARG_KEY),
  requireIdempotencyKey(),
  controller.postKeyMargInvoice,
);
