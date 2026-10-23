import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './lead.controller.js';
import { changeOwnerSchema, leadLookupQuerySchema } from './lead.validation.js';

export const leadRouter = Router();

// Phase 5 (DEC-060) — any desk that works leads. The exact lookup answers
// firm + side + leader only; it is rate-limited per employee and audited.
leadRouter.get(
  '/staff/lookup',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_READ),
  validateQuery(leadLookupQuerySchema),
  controller.getLookup,
);

// Change owner — a leader within his team, Admin anywhere (the service
// decides; the permission only keeps out desks that never hold leads).
leadRouter.post(
  '/staff/buyers/:buyerId/owner',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_READ),
  requireIdempotencyKey(),
  validateBody(changeOwnerSchema),
  controller.postBuyerOwner,
);
leadRouter.post(
  '/staff/sellers/:sellerId/owner',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_READ),
  requireIdempotencyKey(),
  validateBody(changeOwnerSchema),
  controller.postSellerOwner,
);
