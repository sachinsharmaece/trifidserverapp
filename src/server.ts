import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectToDatabase } from './db/connect.js';
import { logger } from './shared/logger.js';
import { registerShutdownHandlers } from './shared/shutdown.js';

async function startServer(): Promise<void> {
  await connectToDatabase(env.mongodbUri);
  const server = http.createServer(createApp());
  registerShutdownHandlers(server);
  server.listen(env.port, () => {
    logger.info({ msg: `TriFid server listening on port ${env.port} (${env.nodeEnv})` });
  });
}

startServer().catch((error: unknown) => {
  // Refuses to start rather than run degraded (e.g. database unreachable).
  console.error('Unable to start server:', error);
  process.exitCode = 1;
});
