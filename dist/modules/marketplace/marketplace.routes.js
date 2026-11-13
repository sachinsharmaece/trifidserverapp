import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions.js';
import { authenticate } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import * as controller from './marketplace.controller.js';
export const marketplaceRouter = Router();
// RECTIFY-01 Phase 0 — 🏢 stop trading at once. Deliberately not lead-scoped: the founder wants staff
// able to stop ANY listing and withdraw ANY seller quote, whichever team the seller sits in; the
// permission (Purchase Leader by position, and Admin) is the gate. Every one is a stage-moving POST,
// so every one needs an Idempotency-Key.
marketplaceRouter.post('/staff/listings/:id/stop', authenticate, requirePermission(PERMISSIONS.LISTING_STOP), requireIdempotencyKey(), controller.postStopListing);
marketplaceRouter.post('/staff/listings/:id/restart', authenticate, requirePermission(PERMISSIONS.LISTING_STOP), requireIdempotencyKey(), controller.postRestartListing);
marketplaceRouter.post('/staff/quotes/:id/withdraw', authenticate, requirePermission(PERMISSIONS.QUOTE_WITHDRAW), requireIdempotencyKey(), controller.postWithdrawQuote);
