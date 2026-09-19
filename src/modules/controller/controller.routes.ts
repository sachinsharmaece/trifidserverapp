import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './controller.controller.js';
import { bulkLifelineSchema } from './controller.validation.js';

export const controllerRouter = Router();

// New — M7, BR-206. 🎛 Controller decides disputes; the four non-
// transit_damage categories only (QR-050 excludes transit_damage this
// session — it never appears in this queue).
controllerRouter.get(
  '/staff/controller/disputes',
  authenticate,
  requirePermission(PERMISSIONS.DISPUTE_READ),
  controller.getDisputeQueue,
);
controllerRouter.post(
  '/staff/controller/disputes/:complaintId/decide',
  authenticate,
  requirePermission(PERMISSIONS.DISPUTE_DECIDE),
  controller.postDecideDispute,
);

// New — M7. MASTER_PLAN.md M7 DoD — "Controller can see every exception in
// one place."
controllerRouter.get(
  '/staff/controller/exceptions',
  authenticate,
  requirePermission(PERMISSIONS.EXCEPTION_READ),
  controller.getExceptionView,
);

// New — M7, BR-234. Maker-checker via checkerEmployeeId in the body (same
// convention and same known limitation as conduct.service.ts's
// advanceConductStage — see controller.service.ts's own comment).
controllerRouter.post(
  '/staff/controller/lifeline/bulk',
  authenticate,
  requirePermission(PERMISSIONS.LIFELINE_GRANT),
  validateBody(bulkLifelineSchema),
  controller.postBulkLifeline,
);
