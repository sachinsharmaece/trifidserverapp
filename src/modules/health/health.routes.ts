import { Router } from 'express';
import { isDatabaseConnected } from '../../db/connect.js';
import { isShuttingDown } from '../../shared/shutdown.js';

export const healthRouter: Router = Router();

// Liveness: "is the process up?" - never touches dependencies.
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: "should the load balancer send me traffic?"
healthRouter.get('/ready', (_req, res) => {
  const database = isDatabaseConnected();
  const shuttingDown = isShuttingDown();
  const ready = database && !shuttingDown;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'unavailable',
    checks: { database: database ? 'up' : 'down', shuttingDown },
  });
});
