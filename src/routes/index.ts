import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Everything the admin app calls lives under /api/v1 (app.ts mounts this router there).
 * Add one line per feature module as it is built, for example:
 *   apiRouter.use('/orders', ordersRouter);
 */
export const apiRouter: Router = Router();

// /api/v1/health and /api/v1/ready: the same probes as at the root, reachable through the admin app's proxy.
apiRouter.use(healthRouter);

// /api/v1/auth/login, /auth/logout and /me.
apiRouter.use(authRouter);
