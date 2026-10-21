import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './pricing.controller.js';
export const pricingRouter = Router();
// API-131 — 🏢 margin_matrix:read / ⚙️ margin_matrix:write (Admin only writes).
pricingRouter.get('/admin/margin-matrix', authenticate, requirePermission(PERMISSIONS.MARGIN_MATRIX_READ), controller.getMarginMatrix);
// API-133 — every row ever written, including future-dated ones.
pricingRouter.get('/admin/margin-matrix/history', authenticate, requirePermission(PERMISSIONS.MARGIN_MATRIX_READ), controller.getMarginMatrixHistory);
// API-132 — several cells under one effectiveFrom, in one write.
pricingRouter.put('/admin/margin-matrix/bulk', authenticate, requirePermission(PERMISSIONS.MARGIN_MATRIX_WRITE), controller.putMarginMatrixBulk);
pricingRouter.put('/admin/margin-matrix', authenticate, requirePermission(PERMISSIONS.MARGIN_MATRIX_WRITE), controller.putMarginMatrix);
