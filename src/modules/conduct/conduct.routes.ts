import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './conduct.controller.js';
import {
  disagreeSchema,
  recordFailureSchema,
  advanceConductStageSchema,
} from './conduct.validation.js';

export const conductRouter = Router();

// API-110 — 👤B.
conductRouter.get('/me/conduct', authenticate, controller.getConduct);
conductRouter.post(
  '/conduct/:id/disagree',
  authenticate,
  validateBody(disagreeSchema),
  controller.postDisagree,
);

// API-111 — 👤S.
conductRouter.get('/me/scorecard', authenticate, controller.getScorecard);

// New — M6. 🏢 Purchase/Sales.
conductRouter.post(
  '/staff/conduct/failures',
  authenticate,
  requirePermission(PERMISSIONS.CONDUCT_RECORD),
  validateBody(recordFailureSchema),
  controller.postRecordFailure,
);
conductRouter.post(
  '/staff/conduct/failures/:id/advance',
  authenticate,
  requirePermission(PERMISSIONS.CONDUCT_ADVANCE),
  validateBody(advanceConductStageSchema),
  controller.postAdvanceConductStage,
);
conductRouter.get(
  '/staff/conduct/counterparties/:counterpartyId/history',
  authenticate,
  requirePermission(PERMISSIONS.CONDUCT_RECORD),
  controller.getConductHistory,
);

// New — M6, QR-025. 🎛 Controller.
conductRouter.get(
  '/staff/conduct/disagreements',
  authenticate,
  requirePermission(PERMISSIONS.CONDUCT_DISPUTES_READ),
  controller.getDisagreementQueue,
);
