import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { env } from './config/env.js';
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
  app.use(express.json());
  app.use(cookieParser());

  app.use(healthRouter);

  app.use(API_PREFIX, identityRouter);
  app.use(API_PREFIX, adminRouter);
  app.use(API_PREFIX, fileRouter);
  app.use(API_PREFIX, territoryRouter);
  app.use(API_PREFIX, exclusionRouter);
  app.use(API_PREFIX, catalogRouter);
  app.use(API_PREFIX, onboardingRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
