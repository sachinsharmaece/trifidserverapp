import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './holding.controller.js';

/**
 * LOCK-34 — dormant parties, lead intake and the Pool. With the policy switched
 * off every route here answers 403 "Dormant policy is switched off." except
 * `status`, which the screens call to learn that.
 */
export const holdingRouter = Router();

holdingRouter.get(
  '/staff/sales/holdings/status',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.status,
);
holdingRouter.get(
  '/staff/sales/holdings/mine',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.mine,
);
holdingRouter.get(
  '/staff/sales/holdings/uncalled-count',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.uncalledCount,
);
holdingRouter.post(
  '/staff/sales/holdings/:holdingId/reason',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  requireIdempotencyKey(),
  controller.reason,
);

holdingRouter.get(
  '/staff/sales/party-pool',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.pool,
);
holdingRouter.get(
  '/staff/sales/party-pool/waiting',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.waiting,
);
holdingRouter.post(
  '/staff/sales/party-pool/:partyId/claim',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  requireIdempotencyKey(),
  controller.claim,
);
holdingRouter.post(
  '/staff/sales/party-pool/:partyId/assign',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  requireIdempotencyKey(),
  controller.assign,
);
holdingRouter.post(
  '/staff/sales/party-pool/:partyId/leave',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  requireIdempotencyKey(),
  controller.leave,
);
holdingRouter.put(
  '/staff/sales/callers/:staffId/receiving-leads',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  requireIdempotencyKey(),
  controller.receivingLeads,
);

// The Dormant policy page (Admin). Writes go through the audited config update.
holdingRouter.get(
  '/admin/dormancy-policy',
  authenticate,
  requirePermission(PERMISSIONS.CONFIG_READ),
  controller.getPolicy,
);
holdingRouter.put(
  '/admin/dormancy-policy',
  authenticate,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  requireIdempotencyKey(),
  controller.putPolicy,
);
