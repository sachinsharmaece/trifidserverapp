import { afterAll, beforeAll } from 'vitest';
import mongoose from 'mongoose';
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

// Every test file starts from an empty database. Files run one at a time on
// one shared in-memory replica set, and nothing used to clear it between
// them — so a test that checks a company-wide total (all buyer debtors, all
// margin-matrix rows) passed or failed depending on which files happened to
// run before it. Documents are deleted, collections and indexes kept: the
// unique-index tests need the indexes Mongoose has already built.
async function emptyEveryCollection(): Promise<void> {
  const uri = env.mongodbUri;
  if (process.env.NODE_ENV !== 'test' || !/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
    throw new Error(`Refusing to empty a database that is not the local test server: ${uri}`);
  }
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

beforeAll(async () => {
  await connectToDatabase(env.mongodbUri);
  await emptyEveryCollection();
  await seedRolesAndPermissions();
  await seedLanes();
  await seedNotificationTemplates();
}, 30000);

afterAll(async () => {
  await disconnectFromDatabase();
});
