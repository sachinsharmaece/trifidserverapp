import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { backfillCallHistory } from '../modules/desk/sales/sales.calls.js';

/**
 * 28 Oct — calls logged on the call page before the fix (raising an ask,
 * accepting a rate, declining, a promoted-offer decision) kept their call
 * note only on the ask or order; this adds the matching call-history row for
 * each, with its original time and staff member. Safe to run twice.
 *
 *   npm run backfill:callHistory                 dry run: counts what it would add, writes nothing
 *   npm run backfill:callHistory -- --apply      adds the rows
 */
async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  const r = await backfillCallHistory({ apply });
  console.log(`Call history backfill — ${apply ? 'apply' : 'dry run'}`);
  console.log(`Staff call notes found on asks and orders: ${r.found}`);
  console.log(`Already in the call history: ${r.alreadyThere}`);
  console.log(`${apply ? 'Added' : 'Would add'}: ${r.added} (${JSON.stringify(r.byAction)})`);
  console.log(`Skipped (buyer not found): ${r.skipped}`);
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Call history backfill failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
