import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter } from './routes/health.js';
import { identityRouter } from './modules/identity/identity.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { fileRouter } from './modules/file/file.routes.js';
import { territoryRouter } from './modules/territory/territory.routes.js';
import { exclusionRouter } from './modules/exclusion/exclusion.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { onboardingRouter } from './modules/onboarding/onboarding.routes.js';
import { pricingRouter } from './modules/pricing/pricing.routes.js';
import { chainRouter } from './modules/chain/chain.routes.js';
import { paymentRouter } from './modules/payment/payment.routes.js';
import { margRouter } from './modules/marg/marg.routes.js';
import { dockRouter } from './modules/dock/dock.routes.js';
import { movementRouter } from './modules/movement/movement.routes.js';
import { listingRouter } from './modules/listing/listing.routes.js';
import { demandRouter } from './modules/demand/demand.routes.js';
import { poolRouter } from './modules/pool/pool.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { conductRouter } from './modules/conduct/conduct.routes.js';
import { purchaseRouter } from './modules/desk/purchase/purchase.routes.js';
import { salesRouter } from './modules/desk/sales/sales.routes.js';
import { controllerRouter } from './modules/controller/controller.routes.js';
import { logisticsRouter } from './modules/logistics/logistics.routes.js';
import { notificationRouter } from './modules/notification/notification.routes.js';
import { founderRouter } from './modules/founder/founder.routes.js';

const API_PREFIX = '/api/v1';

export function createApp(): Express {
  const app = express();

  app.use(requestId);
  app.use(
    cors({
      // origin: env.corsAllowedOrigins,
      origin: true,
      credentials: true,
    }),
  );
  // `verify` keeps the raw bytes alongside the parsed body: Meta's webhook
  // signature (notification.controller.ts) is computed over exactly those bytes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());

  app.use(healthRouter);

  app.use(API_PREFIX, identityRouter);
  app.use(API_PREFIX, adminRouter);
  app.use(API_PREFIX, fileRouter);
  app.use(API_PREFIX, territoryRouter);
  app.use(API_PREFIX, exclusionRouter);
  app.use(API_PREFIX, catalogRouter);
  app.use(API_PREFIX, onboardingRouter);
  app.use(API_PREFIX, pricingRouter);
  app.use(API_PREFIX, chainRouter);
  app.use(API_PREFIX, paymentRouter);
  app.use(API_PREFIX, margRouter);
  app.use(API_PREFIX, dockRouter);
  app.use(API_PREFIX, movementRouter);
  app.use(API_PREFIX, listingRouter);
  app.use(API_PREFIX, demandRouter);
  app.use(API_PREFIX, poolRouter);
  app.use(API_PREFIX, ordersRouter);
  app.use(API_PREFIX, conductRouter);
  app.use(API_PREFIX, purchaseRouter);
  app.use(API_PREFIX, salesRouter);
  app.use(API_PREFIX, controllerRouter);
  app.use(API_PREFIX, logisticsRouter);
  app.use(API_PREFIX, notificationRouter);
  app.use(API_PREFIX, founderRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
