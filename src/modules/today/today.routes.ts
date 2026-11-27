import { Router } from 'express';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { todayView } from './today.js';

/**
 * GET /today: the Controller's Today page (Controller, Founder and Admin). Read only; the buttons on the page are
 * the same trade engine actions as on the deal card (Close as lost in transit, Hold the payout, ...).
 */
export const todayRouter: Router = Router();

todayRouter.get(
  '/today',
  requireAuth,
  requireRole('CONTROLLER', 'FOUNDER', 'ADMIN'),
  async (_req, res) => {
    res.json(await todayView());
  },
);
