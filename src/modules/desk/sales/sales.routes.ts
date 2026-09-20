import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../../config/permissions.js';
import * as controller from './sales.controller.js';

export const salesRouter = Router();

// New — M6. 🏢 Sales.
salesRouter.get(
  '/staff/sales/worklist',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getWorklist,
);
salesRouter.get(
  '/staff/sales/pulse',
  authenticate,
  requirePermission(PERMISSIONS.PULSE_READ),
  controller.getMarketPulse,
);
salesRouter.get(
  '/staff/sales/retention',
  authenticate,
  requirePermission(PERMISSIONS.RETENTION_READ),
  controller.getRetention,
);
salesRouter.get(
  '/staff/sales/complaints',
  authenticate,
  requirePermission(PERMISSIONS.COMPLAINT_READ),
  controller.getComplaintQueue,
);
salesRouter.get(
  '/staff/sales/msp',
  authenticate,
  requirePermission(PERMISSIONS.MSP_RESPOND),
  controller.getMspQueue,
);
salesRouter.post(
  '/staff/sales/msp/:id/respond',
  authenticate,
  requirePermission(PERMISSIONS.MSP_RESPOND),
  controller.postMspResponse,
);

// 👤B — a buyer requesting a rate the board does not show him.
salesRouter.post('/me/msp-requests', authenticate, controller.postMspRequest);
salesRouter.get('/me/msp-requests', authenticate, controller.getMyMspRequests);
