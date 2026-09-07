import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { getHeartbeatAgeSeconds } from '../worker/heartbeat.js';
import { logger } from '../shared/logger.js';

export const healthRouter = Router();

// CH §25.5 — the queue heartbeat is "the single highest-value alarm in the
// system." A stale heartbeat means the worker died silently; this endpoint
// is where that becomes visible until real alerting infrastructure exists.
const STALE_MULTIPLIER = 3;

healthRouter.get('/health', async (_request, response) => {
  const dbState = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const heartbeatAgeSeconds = await getHeartbeatAgeSeconds();
  const staleThreshold = env.workerHeartbeatSeconds * STALE_MULTIPLIER;
  const stale = heartbeatAgeSeconds === null || heartbeatAgeSeconds > staleThreshold;

  if (stale) {
    logger.warn({
      msg: 'Worker heartbeat is stale or missing',
      heartbeatAgeSeconds,
      staleThreshold,
    });
  }

  response.json({
    status: 'ok',
    db: dbState,
    worker: { heartbeatAgeSeconds, stale },
  });
});

healthRouter.get('/version', (_request, response) => {
  response.json({ name: 'trifid-serverapp', version: process.env.npm_package_version ?? '0.1.0' });
});
