import { afterAll, beforeAll } from 'vitest';
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect.js';
import { seedRolesAndPermissions } from '../src/db/seedRoles.js';
import { seedLanes } from '../src/db/seedLanes.js';
import { seedNotificationTemplates } from '../src/modules/notification/notification.templates.js';
import { env } from '../src/config/env.js';

// ENQUIRY_FLOW_ENABLED/CHAIN_STAGE_TRACKING_ENABLED default to 'true' for the
// whole suite via vitest.config.ts's `test.env` (not here — `env.ts`'s
// `export const env = {...}` reads `process.env` once at import time, and
// this file's own `import { env } ...` above is hoisted ahead of any
// `process.env` assignment placed below it, so setting it here would always
// be too late).

beforeAll(async () => {
  await connectToDatabase(env.mongodbUri);
  await seedRolesAndPermissions();
  await seedLanes();
  await seedNotificationTemplates();
}, 30000);

afterAll(async () => {
  await disconnectFromDatabase();
});
