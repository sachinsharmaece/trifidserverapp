import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './accounts.controller.js';

export const accountsRouter = Router();

// The Accounts desk's read model — one snapshot the screen derives every view from.
// It puts a buyer and a seller on the same record, so it needs the un-projected chain
// view (BR-070), not `receipt:read`, which Sales also holds.
accountsRouter.get(
  '/staff/accounts/snapshot',
  authenticate,
  requirePermission(PERMISSIONS.CHAIN_READ_FULL),
  controller.getAccountsSnapshot,
);
