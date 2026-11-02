import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import {
  migrateBuyerIdentity,
  rollbackBuyerIdentityMigration,
} from '../modules/onboarding/buyer.migration.js';

/**
 * Phase 3 — buyer identity and category (modules/onboarding/buyer.migration.ts).
 *
 *   npm run migrate:buyerIdentity                 dry run: prints the report, writes nothing
 *   npm run migrate:buyerIdentity -- --apply      does it (backs up each changed value first)
 *   npm run migrate:buyerIdentity -- --rollback   restores the backed-up values
 */
async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const rollback = process.argv.includes('--rollback');
  if (!apply && !rollback) {
    // A dry run must not write anything — not even the indexes Mongoose
    // builds on connect.
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  if (rollback) {
    const { restored } = await rollbackBuyerIdentityMigration();
    console.log(`Rolled back: ${restored} value(s) restored.`);
  } else {
    const r = await migrateBuyerIdentity({ apply });
    console.log(`Buyer identity migration — ${r.mode}`);
    console.log(`Old unique mobile index (mobile_1): ${r.legacyMobileIndex}`);
    console.log(`contactMobile ${apply ? 'filled' : 'to fill'}: ${r.contactMobileFilled}`);
    console.log(`PAN from GSTIN ${apply ? 'filled' : 'to fill'}: ${r.panFilled}`);
    console.log(`Category ${apply ? 'set' : 'to set'}: ${JSON.stringify(r.categorySet)}`);
    console.log(`Never classified (no category, priced as Retailer as before): ${r.unclassified}`);
    console.log(
      `Address from GST place of business ${apply ? 'filled' : 'to fill'}: ${r.addressFilled}`,
    );
    if (r.marginColumnMismatches.length > 0) {
      console.log('STOPPED — margin column would change for:');
      for (const line of r.marginColumnMismatches) console.log(`  - ${line}`);
      process.exitCode = 1;
    }
  }
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Buyer identity migration failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
