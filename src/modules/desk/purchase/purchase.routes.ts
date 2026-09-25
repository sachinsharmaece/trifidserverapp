import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/requirePermission.js';
import { validateBody } from '../../../middleware/validate.js';
import { PERMISSIONS } from '../../../config/permissions.js';
import * as controller from './purchase.controller.js';
import {
  draftManufacturerSchema,
  draftProductSchema,
  draftSkuSchema,
  sellerCatalogueEntrySchema,
} from './purchase.validation.js';

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
// Purchase-desk v2 — per-ask seller states in the prototype's own vocabulary.
purchaseRouter.get(
  '/staff/purchase/asks/:askId/seller-states',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getAskSellerStates,
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

// ---------------------------------------------------------------------------
// Purchase-desk v2.
// ---------------------------------------------------------------------------

// The seller catalogue — what a seller can supply. DEMAND_READ for reads
// (same boundary as the rest of this desk's reads); PO_EDIT-adjacent writes
// stay on the desk's own write permission, DEMAND_READ, since there is no
// money and no board visibility in a catalogue entry (see purchase.service.ts).
purchaseRouter.get(
  '/staff/purchase/sellers/:sellerId/catalogue',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getSellerCatalogue,
);
purchaseRouter.post(
  '/staff/purchase/catalogue',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  validateBody(sellerCatalogueEntrySchema),
  controller.postSellerCatalogueEntry,
);
purchaseRouter.get(
  '/staff/purchase/sellers/:sellerId/file',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getSellerFile,
);

// Supply matrix — computed from the catalogue + live listings.
purchaseRouter.get(
  '/staff/purchase/matrix/by-product',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getSupplyMatrixByProduct,
);
purchaseRouter.get(
  '/staff/purchase/matrix/by-seller',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getSupplyMatrixBySeller,
);

// Confirmations — piles waiting on a seller's decision.
purchaseRouter.get(
  '/staff/purchase/piles',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getPilesAwaitingDecision,
);

// Dispatch — Purchase's own pre-leg-1 chase queue. `po:edit` (already held —
// see chain.service.ts's dispatch-clock fields) since logging a chase touches the PO.
purchaseRouter.get(
  '/staff/purchase/dispatch',
  authenticate,
  requirePermission(PERMISSIONS.PO_EDIT),
  controller.getDispatchChaseQueue,
);
purchaseRouter.post(
  '/staff/purchase/dispatch/:poId/chase',
  authenticate,
  requirePermission(PERMISSIONS.PO_EDIT),
  controller.postDispatchChase,
);

// Recovery — dock findings still waiting on Purchase's own apply act.
// Applying itself is the pre-existing `POST /staff/pos/:poId/inspections/apply`
// (`modules/dock`) — this only reads the queue.
purchaseRouter.get(
  '/staff/purchase/inspections/pending-apply',
  authenticate,
  requirePermission(PERMISSIONS.PO_EDIT),
  controller.getInspectionsPendingApply,
);

// Products → Analysis, every row in one call.
purchaseRouter.get(
  '/staff/purchase/products/analysis',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getProductAnalysisAll,
);
purchaseRouter.get(
  '/staff/purchase/products/funnel',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getProductFunnelAll,
);

// Draft masters (LOCK-26-style amendment, CATALOG_DRAFT_CREATE) — usable in a
// seller's catalogue at once, cannot back a live listing until Admin confirms
// them via the pre-existing CATALOG_WRITE PATCHes in modules/catalog.
purchaseRouter.get(
  '/staff/purchase/masters/drafts',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getDraftMasters,
);
purchaseRouter.get(
  '/staff/purchase/masters/manufacturers',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getMastersManufacturers,
);
purchaseRouter.get(
  '/staff/purchase/masters/products',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getMastersProducts,
);
purchaseRouter.get(
  '/staff/purchase/debits',
  authenticate,
  requirePermission(PERMISSIONS.DEMAND_READ),
  controller.getOpenSellerDebits,
);
purchaseRouter.post(
  '/staff/purchase/masters/manufacturers',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_DRAFT_CREATE),
  validateBody(draftManufacturerSchema),
  controller.postDraftManufacturer,
);
purchaseRouter.post(
  '/staff/purchase/masters/products',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_DRAFT_CREATE),
  validateBody(draftProductSchema),
  controller.postDraftProduct,
);
purchaseRouter.post(
  '/staff/purchase/masters/skus',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_DRAFT_CREATE),
  validateBody(draftSkuSchema),
  controller.postDraftSku,
);
