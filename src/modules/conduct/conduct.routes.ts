import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './conduct.controller.js';
import { disagreeSchema } from './conduct.validation.js';

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
