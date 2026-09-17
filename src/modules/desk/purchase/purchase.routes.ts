import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../../config/permissions.js';
import * as controller from './purchase.controller.js';

export const purchaseRouter = Router();

// New — M6. 🏢 Purchase. BR-069 — every response below carries no buyer
// identity and no rupee figure; see purchase.service.ts's own DTOs.
purchaseRouter.get(
  '/staff/purchase/demand',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getActiveDemandList,
);
purchaseRouter.get(
  '/staff/purchase/asks/:askId/quote-gaps',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getQuoteGaps,
);
purchaseRouter.get(
  '/staff/purchase/coverage-map',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getCoverageMap,
);
purchaseRouter.get(
  '/staff/purchase/products/:productId/analysis',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getProductAnalysis,
);
// IC-06 — the response never carries the cap or the two source rates.
purchaseRouter.get(
  '/staff/purchase/absorption',
  authenticate,
  requirePermission(PERMISSIONS.ABSORPTION_READ),
  controller.getAbsorptionQueue,
);
purchaseRouter.post(
  '/staff/purchase/non-order-reasons',
  authenticate,
  requirePermission(PERMISSIONS.NON_ORDER_REASON_RECORD),
  controller.postNonOrderReason,
);
purchaseRouter.get(
  '/staff/purchase/return-notes/ageing',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getReturnNoteAgeing,
);
