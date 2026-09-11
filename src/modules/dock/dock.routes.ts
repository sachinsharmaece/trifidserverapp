import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './dock.controller.js';

export const dockRouter = Router();

// API-087 — 🏢 dock:inspect (Transport & Logistics).
dockRouter.post(
  '/staff/pos/:poId/inspections',
  authenticate,
  requirePermission(PERMISSIONS.DOCK_INSPECT),
  controller.postInspection,
);

// New — BR-190's Purchase half. 🏢 po:edit. Idempotency-Key required — creates the seller bill/debit note/refund.
dockRouter.post(
  '/staff/pos/:poId/inspections/apply',
  authenticate,
  requirePermission(PERMISSIONS.PO_EDIT),
  requireIdempotencyKey(),
  controller.postApplyInspection,
);
