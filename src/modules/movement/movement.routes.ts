import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './movement.controller.js';

export const movementRouter = Router();

// API-089 — 🏢 movement:write (Transport & Logistics). Idempotency-Key required — moves the chain stage.
movementRouter.post(
  '/staff/chains/:chainId/movements',
  authenticate,
  requirePermission(PERMISSIONS.MOVEMENT_WRITE),
  requireIdempotencyKey(),
  controller.postMovement,
);
