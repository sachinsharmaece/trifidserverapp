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
// New — M8, BR-275. Funnel and leak analytics: counts, hours and percentages only —
// no rupee figure and no buyer identity (BR-067/BR-069), each metric carrying its own formula.
purchaseRouter.get(
  '/staff/purchase/funnel',
  authenticate,
  requirePermission(PERMISSIONS.FUNNEL_READ),
  controller.getFunnelReport,
);
// New — M7, BR-206. The seller-recovery half of a Controller-decided
// dispute — never the buyer, never the buyer's note (see purchase.service.ts).
purchaseRouter.get(
  '/staff/purchase/dispute-recovery',
  authenticate,
  requirePermission(PERMISSIONS.DISPUTE_RECOVERY_READ),
  controller.getSellerRecoveryQueue,
);
