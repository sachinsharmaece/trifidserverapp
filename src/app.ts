import cors from 'cors';
import express from 'express';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(healthRouter);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
