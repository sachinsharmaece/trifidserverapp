import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { scopeReadiness } from '../shared/scopeReadiness.js';

/**
 * Phase 7 — run before setting OWNERSHIP_SCOPE_ENFORCED=true. Read only.
 *
 *   npm run check:scopeReadiness
 *
 * Exits 1 while anyone would be left seeing only his own leads by accident.
 */
async function run(): Promise<void> {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await connectToDatabase(env.mongodbUri);
  const r = await scopeReadiness();
  const list = (title: string, people: string[]) => {
    console.log(`${title} (${people.length})`);
    for (const p of people) console.log(`  - ${p}`);
  };
  console.log('Lead visibility (OWNERSHIP_SCOPE_ENFORCED) — readiness');
  list('Sales/Purchase staff with no position', r.noPosition);
  list('Executives with no leader on that side', r.noLeader);
  list('Accounts/Logistics with no "works for" teams', r.noTeams);
  console.log(`Buyers in the Queue (leaders and Admin only): ${r.buyersInQueue}`);
  console.log(`Sellers in the Queue (leaders and Admin only): ${r.sellersInQueue}`);
  console.log(
    r.ready
      ? 'READY — the flag can be switched on.'
      : 'NOT READY — fix the above on the Team page first.',
  );
  if (!r.ready) process.exitCode = 1;
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Scope readiness check failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
