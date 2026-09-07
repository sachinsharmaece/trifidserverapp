import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './file.controller.js';
import * as fileService from './file.service.js';
import { createFileSchema } from './file.validation.js';

export const fileRouter = Router();

// `authenticate` is applied per route, not via `fileRouter.use(...)` — every
// router in app.ts is mounted at the same "/api/v1" prefix, and Express
// dispatches a request through each mounted router in turn until one
// matches. A router-level `.use(authenticate)` with no path runs for every
// request that reaches this router, including paths this router does not
// own, and an unauthenticated one would 401 before a later, public router
// (e.g. onboarding's registration endpoints) ever got a chance to answer it.

// API-141 (new — file upload/download stubs, ARCHITECTURE.md §3.1 scope).
fileRouter.post('/files', authenticate, validateBody(createFileSchema), controller.postFile);
// API-142 — ownership check per ARCHITECTURE.md §8: a short-lived signed
// download URL, never handed out without verifying the caller owns the file.
fileRouter.get(
  '/files/:id/download-url',
  authenticate,
  requireOwnership((req) => fileService.findFileOwner(req.params.id as string)),
  controller.getDownloadUrl,
);
