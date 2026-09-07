import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './exclusion.controller.js';
import { createExclusionSchema, lookupSchema } from './exclusion.validation.js';

export const exclusionRouter = Router();

// `authenticate` is applied per route, not via `exclusionRouter.use(...)` —
// see the comment in modules/file/file.routes.ts.

// API-120 — a GSTIN-enumeration oracle; rate limiting lives in the service.
exclusionRouter.post(
  '/exclusions/lookup',
  authenticate,
  validateBody(lookupSchema),
  controller.postLookup,
);

// API-121
exclusionRouter.get('/exclusions', authenticate, controller.getExclusions);
exclusionRouter.post(
  '/exclusions',
  authenticate,
  validateBody(createExclusionSchema),
  controller.postExclusion,
);
exclusionRouter.delete('/exclusions/:id', authenticate, controller.deleteExclusion);
