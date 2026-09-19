import { afterAll, beforeAll } from 'vitest';
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect.js';
import { seedRolesAndPermissions } from '../src/db/seedRoles.js';
import { seedLanes } from '../src/db/seedLanes.js';
import { seedNotificationTemplates } from '../src/modules/notification/notification.templates.js';
import { env } from '../src/config/env.js';

beforeAll(async () => {
  await connectToDatabase(env.mongodbUri);
  await seedRolesAndPermissions();
  await seedLanes();
  await seedNotificationTemplates();
}, 30000);

afterAll(async () => {
  await disconnectFromDatabase();
});
