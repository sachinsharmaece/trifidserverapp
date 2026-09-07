import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './file.controller.js';
import * as fileService from './file.service.js';
import { createFileSchema } from './file.validation.js';

export const fileRouter = Router();

fileRouter.use(authenticate);

// API-141 (new — file upload/download stubs, ARCHITECTURE.md §3.1 scope).
fileRouter.post('/files', validateBody(createFileSchema), controller.postFile);
// API-142 — ownership check per ARCHITECTURE.md §8: a short-lived signed
// download URL, never handed out without verifying the caller owns the file.
fileRouter.get(
  '/files/:id/download-url',
  requireOwnership((req) => fileService.findFileOwner(req.params.id as string)),
  controller.getDownloadUrl,
);
