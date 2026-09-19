import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { getFounderOverview } from './founder.service.js';

export const founderRouter = Router();

// New — M8. Read-only. There is deliberately no POST/PUT/PATCH/DELETE under /founder.
founderRouter.get(
  '/founder/overview',
  authenticate,
  requirePermission(PERMISSIONS.FOUNDER_OVERVIEW_READ),
  async (req: Request, res: Response): Promise<void> => {
    res
      .status(200)
      .json({ data: await getFounderOverview(), meta: { correlationId: req.correlationId } });
  },
);
