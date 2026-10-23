import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../../middleware/idempotency.js';
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
// Phase 3 — the "Assigned to" picker: who this caller may assign a buyer to.
salesRouter.get(
  '/staff/sales/assignees',
  authenticate,
  requirePermission(PERMISSIONS.SALES_WORKLIST_READ),
  controller.getAssignees,
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

// Buyer file stage buttons. Raising an ask, confirming a rate and walking away reuse the
// /staff/proxy/buyer/* endpoints; these three had none.
salesRouter.post(
  '/staff/sales/asks/:askId/give-rate',
  authenticate,
  requirePermission(PERMISSIONS.PROXY_BUYER_CALL),
  controller.postGiveRate,
);
// A quote already raised on his ask (parked for Sales) — give it to him as a rate.
salesRouter.post(
  '/staff/sales/quotes/:quoteId/give',
  authenticate,
  requirePermission(PERMISSIONS.PROXY_BUYER_CALL),
  controller.postGiveParkedQuote,
);
// Money-moving: Sales takes the payment itself, so it has its own permission.
salesRouter.post(
  '/staff/sales/orders/:soId/mark-paid',
  authenticate,
  requirePermission(PERMISSIONS.SALES_MARK_PAID),
  requireIdempotencyKey(),
  controller.postMarkPaid,
);
salesRouter.post(
  '/staff/sales/orders/:soId/mark-billed',
  authenticate,
  requirePermission(PERMISSIONS.SALES_MARK_BILLED),
  requireIdempotencyKey(),
  controller.postMarkBilled,
);
// INTERIM — see PERMISSIONS.SALES_SKIP_TO_BILLED.
salesRouter.post(
  '/staff/sales/orders/:soId/skip-to-billed',
  authenticate,
  requirePermission(PERMISSIONS.SALES_SKIP_TO_BILLED),
  requireIdempotencyKey(),
  controller.postSkipToBilled,
);
salesRouter.post(
  '/staff/sales/orders/:soId/dispatch',
  authenticate,
  requirePermission(PERMISSIONS.SALES_DISPATCH),
  requireIdempotencyKey(),
  controller.postDispatchOrder,
);
// The buyer's own confirmation of receipt, recorded by Sales on a call.
salesRouter.post(
  '/staff/sales/orders/:soId/mark-delivered',
  authenticate,
  requirePermission(PERMISSIONS.PROXY_BUYER_CALL),
  requireIdempotencyKey(),
  controller.postMarkDelivered,
);
salesRouter.post(
  '/staff/sales/orders/:soId/cancel',
  authenticate,
  requirePermission(PERMISSIONS.PROXY_BUYER_CALL),
  controller.postCancelOrder,
);

// 👤B — a buyer requesting a rate the board does not show him.
salesRouter.post('/me/msp-requests', authenticate, controller.postMspRequest);
salesRouter.get('/me/msp-requests', authenticate, controller.getMyMspRequests);
