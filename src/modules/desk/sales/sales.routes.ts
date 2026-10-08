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

// Sales desk v2 — work-stream A. Every route below reuses SALES_WORKLIST_READ
// as the read gate (no new permission keys), matching the spec for this batch.
salesRouter.post(
  '/staff/sales/calls',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.postCallLog,
);
salesRouter.get(
  '/staff/sales/calls',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getCallLogs,
);
salesRouter.get(
  '/staff/sales/promises',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getPromises,
);
salesRouter.get(
  '/staff/sales/board',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getBoard,
);
salesRouter.get(
  '/staff/sales/board/:productId',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getBoardProduct,
);
salesRouter.get(
  '/staff/sales/pools',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getPools,
);
salesRouter.get(
  '/staff/sales/pools/:poolId',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getPool,
);
salesRouter.get(
  '/staff/sales/buyers',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getBuyers,
);
salesRouter.get(
  '/staff/sales/buyers/:buyerId',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getBuyerFile,
);
salesRouter.get(
  '/staff/sales/buyers/:buyerId/board',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getBuyerBoard,
);
salesRouter.get(
  '/staff/sales/orders',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getOrders,
);
salesRouter.get(
  '/staff/sales/funnel',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getFunnel,
);
salesRouter.get(
  '/staff/sales/funnel/asked',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getFunnelAsks,
);
salesRouter.get(
  '/staff/sales/funnel/rate-held',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getFunnelHeldRates,
);

// 👤B — a buyer requesting a rate the board does not show him.
salesRouter.post('/me/msp-requests', authenticate, controller.postMspRequest);
salesRouter.get('/me/msp-requests', authenticate, controller.getMyMspRequests);
