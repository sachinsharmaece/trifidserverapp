import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './logistics.controller.js';

export const logisticsRouter = Router();

// New — M7. 🚚 Transport & Logistics. BR-176's transporter master.
logisticsRouter.post(
  '/staff/logistics/transporters',
  authenticate,
  requirePermission(PERMISSIONS.TRANSPORTER_WRITE),
  controller.postTransporter,
);
logisticsRouter.get(
  '/staff/logistics/transporters',
  authenticate,
  requirePermission(PERMISSIONS.TRANSPORTER_READ),
  controller.getTransporters,
);

// New — M7. Hub position and dwell.
logisticsRouter.post(
  '/staff/logistics/pos/:poId/goods-in',
  authenticate,
  requirePermission(PERMISSIONS.LOGISTICS_READ),
  controller.postGoodsIn,
);
logisticsRouter.get(
  '/staff/logistics/hub-position',
  authenticate,
  requirePermission(PERMISSIONS.LOGISTICS_READ),
  controller.getHubPosition,
);

// New — M7, BR-178. Physical/freight grouping only (QR-014 — never an
// invoice-level merge).
logisticsRouter.post(
  '/staff/logistics/consolidations',
  authenticate,
  requirePermission(PERMISSIONS.CONSOLIDATION_WRITE),
  controller.postConsolidation,
);

// New — M7. ST-12's missing middle state.
logisticsRouter.post(
  '/staff/logistics/return-notes/:returnNoteId/arrange-collection',
  authenticate,
  requirePermission(PERMISSIONS.RETURN_NOTE_CLOSE),
  controller.postArrangeReturnCollection,
);
logisticsRouter.post(
  '/staff/logistics/return-notes/:returnNoteId/close',
  authenticate,
  requirePermission(PERMISSIONS.RETURN_NOTE_CLOSE),
  controller.postCloseReturnNote,
);

// New — M7.
logisticsRouter.get(
  '/staff/logistics/dashboard',
  authenticate,
  requirePermission(PERMISSIONS.LOGISTICS_READ),
  controller.getDashboard,
);
