import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './pricing.controller.js';

export const pricingRouter = Router();

// API-131 — 🏢 margin_matrix:read / ⚙️ margin_matrix:write (Admin only writes).
pricingRouter.get(
  '/admin/margin-matrix',
  authenticate,
  requirePermission(PERMISSIONS.MARGIN_MATRIX_READ),
  controller.getMarginMatrix,
);
pricingRouter.put(
  '/admin/margin-matrix',
  authenticate,
  requirePermission(PERMISSIONS.MARGIN_MATRIX_WRITE),
  controller.putMarginMatrix,
);
