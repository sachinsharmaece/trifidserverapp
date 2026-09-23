import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './proxy.controller.js';
import {
  proxyRaiseAskSchema,
  proxyAcceptAskFillSchema,
  proxyDeclineAskSchema,
  proxyPromotionDecisionSchema,
  proxyCreateListingSchema,
  proxyConfirmPileSchema,
  proxyPileDecisionSchema,
} from './proxy.validation.js';

/**
 * Staff-assisted enquiries — a phone-call proxy layer over the existing
 * ask/quote/listing flows (WF-04, WF-05, WF-09, WF-11). No new business
 * logic: every action below calls the exact same service function the
 * counterparty's own endpoint calls (demand.service.ts, listing.service.ts,
 * orders.service.ts), gated by a desk-only permission — `proxy:buyer_call`
 * for Sales, `proxy:seller_call` for Purchase — never a role name. The
 * targeted counterparty's own kind (Buyer/Seller document lookup inside
 * each underlying service) is what refuses a mismatched proxy, exactly the
 * same way it already refuses a counterparty acting on the wrong side.
 */
export const proxyRouter = Router();

const buyerCall = [authenticate, requirePermission(PERMISSIONS.PROXY_BUYER_CALL)];
const sellerCall = [authenticate, requirePermission(PERMISSIONS.PROXY_SELLER_CALL)];

// Maps to API-040.
proxyRouter.post(
  '/staff/proxy/buyer/asks',
  ...buyerCall,
  validateBody(proxyRaiseAskSchema),
  controller.postBuyerCallAsk,
);
// Maps to API-042.
proxyRouter.post(
  '/staff/proxy/buyer/asks/:id/accept',
  ...buyerCall,
  requireIdempotencyKey(),
  validateBody(proxyAcceptAskFillSchema),
  controller.postBuyerCallAcceptFill,
);
// Maps to API-043.
proxyRouter.post(
  '/staff/proxy/buyer/asks/:id/decline',
  ...buyerCall,
  validateBody(proxyDeclineAskSchema),
  controller.postBuyerCallDecline,
);
// Maps to API-071.
proxyRouter.post(
  '/staff/proxy/buyer/orders/:id/promotion/accept',
  ...buyerCall,
  requireIdempotencyKey(),
  validateBody(proxyPromotionDecisionSchema),
  controller.postBuyerCallAcceptPromotion,
);
proxyRouter.post(
  '/staff/proxy/buyer/orders/:id/promotion/reject',
  ...buyerCall,
  validateBody(proxyPromotionDecisionSchema),
  controller.postBuyerCallRejectPromotion,
);

// Maps to API-033.
proxyRouter.post(
  '/staff/proxy/seller/listings',
  ...sellerCall,
  validateBody(proxyCreateListingSchema),
  controller.postSellerCallListing,
);
// Maps to API-049.
proxyRouter.post(
  '/staff/proxy/seller/confirmations/:id/confirm',
  ...sellerCall,
  requireIdempotencyKey(),
  validateBody(proxyConfirmPileSchema),
  controller.postSellerCallConfirmPile,
);
// Maps to API-050.
proxyRouter.post(
  '/staff/proxy/seller/confirmations/:id/requote',
  ...sellerCall,
  validateBody(proxyPileDecisionSchema),
  controller.postSellerCallRequotePile,
);
proxyRouter.post(
  '/staff/proxy/seller/confirmations/:id/decline',
  ...sellerCall,
  validateBody(proxyPileDecisionSchema),
  controller.postSellerCallDeclinePile,
);
