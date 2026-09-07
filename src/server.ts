import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectToDatabase } from './db/connect.js';
import { seedRolesAndPermissions } from './db/seedRoles.js';
import { seedLanes } from './db/seedLanes.js';
import { logger } from './shared/logger.js';

async function startServer(): Promise<void> {
  await connectToDatabase(env.mongodbUri);
  await seedRolesAndPermissions();
  await seedLanes();
  createApp().listen(env.port, () => {
    logger.info({ msg: `TriFid server listening on port ${env.port}` });
  });
}

startServer().catch((error: unknown) => {
  // Refuses to start rather than run degraded (ARCHITECTURE.md §4.1) — most
  // commonly this is the replica-set check in db/connect.ts failing.
  console.error('Unable to start server:', error);
  process.exitCode = 1;
});
