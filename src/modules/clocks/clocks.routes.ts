import { Router } from 'express';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { runDormancyClocks } from '../dormancy/dormancy.js';
import { runClocks } from './clocks.js';

/**
 * POST /clocks/run → { delivered, archived, dormancy }. "Run now" for the supervisors: the same job the 15-minute
 * timer runs (modules/clocks/clocks.ts), for when nobody wants to wait for the next tick. It also runs the daily
 * dormancy clock (reference run-clocks does the same); running it twice in a day changes nothing more.
 */
export const clocksRouter: Router = Router();

clocksRouter.post(
  '/clocks/run',
  requireAuth,
  requireRole('CONTROLLER', 'FOUNDER', 'ADMIN'),
  async (_req, res) => {
    res.json({ ...(await runClocks()), dormancy: await runDormancyClocks() });
  },
);
