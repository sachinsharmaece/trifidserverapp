import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter } from './modules/health/health.routes.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './shared/errors.js';

/**
 * Builds the Express app (without starting it, so tests can use it directly).
 * Order matters: request id first, so every log line and error body can carry it.
 */
export function createApp(): Express {
  const app = express();

  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  // Photos (reference-copy branch) come as base64 JSON, so /uploads takes up to 8 MB; everything else 256 kB.
  const smallJson = express.json({ limit: '256kb' });
  const uploadJson = express.json({ limit: '8mb' });
  app.use((req, res, next) =>
    (req.path.endsWith('/uploads') ? uploadJson : smallJson)(req, res, next),
  );

  // Load-balancer probes stay at the root: /health and /ready.
  app.use(healthRouter);

  // The admin app's API.
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
