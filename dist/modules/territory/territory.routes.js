import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './territory.controller.js';
import { createDistrictSchema, createStateSchema, createTehsilSchema, listDistrictsQuerySchema, listPincodesQuerySchema, listTehsilsQuerySchema, updatePincodeSchema, updateTehsilSchema, } from './territory.validation.js';
export const territoryRouter = Router();
// `authenticate` is applied per route, not via `territoryRouter.use(...)` —
// see the comment in modules/file/file.routes.ts.
//
// Phase 1 location masters. Reads: TERRITORY_READ (every desk that fills a
// location in). Adding a State/District/Tehsil and editing a tehsil:
// LOCATION_MASTER_WRITE. Pincode verify: PINCODE_VERIFY. Every write needs an
// Idempotency-Key (the "every POST/PATCH" standard).
const read = [authenticate, requirePermission(PERMISSIONS.TERRITORY_READ)];
const masterWrite = [
    authenticate,
    requirePermission(PERMISSIONS.LOCATION_MASTER_WRITE),
    requireIdempotencyKey(),
];
territoryRouter.get('/admin/states', ...read, controller.getStates);
territoryRouter.post('/admin/states', ...masterWrite, validateBody(createStateSchema), controller.postState);
territoryRouter.get('/admin/districts', ...read, validateQuery(listDistrictsQuerySchema), controller.getDistricts);
territoryRouter.post('/admin/districts', ...masterWrite, validateBody(createDistrictSchema), controller.postDistrict);
// API-026
territoryRouter.get('/admin/tehsils', ...read, validateQuery(listTehsilsQuerySchema), controller.getTehsils);
territoryRouter.post('/admin/tehsils', ...masterWrite, validateBody(createTehsilSchema), controller.postTehsil);
territoryRouter.patch('/admin/tehsils/:id', ...masterWrite, validateBody(updateTehsilSchema), controller.patchTehsil);
territoryRouter.get('/admin/pincodes', ...read, validateQuery(listPincodesQuerySchema), controller.getPincodes);
territoryRouter.get('/admin/pincodes/:pincode', ...read, controller.getPincode);
territoryRouter.patch('/admin/pincodes/:pincode', authenticate, requirePermission(PERMISSIONS.PINCODE_VERIFY), requireIdempotencyKey(), validateBody(updatePincodeSchema), controller.patchPincode);
// API-027 — 👤S, checked inside the controller (a seller reading his own
// area, never a client-supplied id).
territoryRouter.get('/me/area', authenticate, controller.getMyArea);
