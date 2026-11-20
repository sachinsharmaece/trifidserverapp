import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { hsnCodesRouter } from '../modules/masters/hsnCodes.routes.js';
import { manufacturersRouter } from '../modules/masters/manufacturers.routes.js';
import { productsRouter } from '../modules/masters/products.routes.js';
import { skusRouter } from '../modules/masters/skus.routes.js';
import { technicalsRouter } from '../modules/masters/technicals.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
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

// /api/v1/users: staff accounts (Founder and Admin only).
apiRouter.use(usersRouter);

// /api/v1/manufacturers, /technicals, /hsn-codes, /products and /skus: the masters.
// Everyone signed in can read them; only Founder and Admin can change them.
apiRouter.use(manufacturersRouter);
apiRouter.use(technicalsRouter);
apiRouter.use(hsnCodesRouter);
apiRouter.use(productsRouter);
apiRouter.use(skusRouter);
