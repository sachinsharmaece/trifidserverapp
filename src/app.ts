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

const API_PREFIX = '/api/v1';

export function createApp(): Express {
  const app = express();

  app.use(requestId);
  app.use(
    cors({
      origin: env.corsAllowedOrigins,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.use(healthRouter);

  app.use(API_PREFIX, identityRouter);
  app.use(API_PREFIX, adminRouter);
  app.use(API_PREFIX, fileRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
