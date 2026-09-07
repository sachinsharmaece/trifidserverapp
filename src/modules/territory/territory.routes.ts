import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './territory.controller.js';
import { createTehsilSchema, listTehsilsQuerySchema } from './territory.validation.js';

export const territoryRouter = Router();

// `authenticate` is applied per route, not via `territoryRouter.use(...)` —
// see the comment in modules/file/file.routes.ts.

// API-026
territoryRouter.get(
  '/admin/tehsils',
  authenticate,
  requirePermission(PERMISSIONS.TERRITORY_READ),
  validateQuery(listTehsilsQuerySchema),
  controller.getTehsils,
);
territoryRouter.post(
  '/admin/tehsils',
  authenticate,
  requirePermission(PERMISSIONS.TERRITORY_WRITE),
  validateBody(createTehsilSchema),
  controller.postTehsil,
);

// API-027 — 👤S, checked inside the controller (a seller reading his own
// area, never a client-supplied id).
territoryRouter.get('/me/area', authenticate, controller.getMyArea);
