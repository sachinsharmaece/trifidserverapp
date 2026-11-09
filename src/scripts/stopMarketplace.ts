import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import {
  REPORT_COLUMNS,
  applyStop,
  parseReason,
  parseScope,
  planStop,
  resolveActor,
} from '../modules/marketplace/marketplace.bulk.js';
import {
  argValue,
  assertDatabaseAllowed,
  hasFlag,
  stamp,
  writeReport,
} from '../shared/scriptSupport.js';

/**
 * RECTIFY-01 Phase 0 — stop trading at once, for a whole scope. Stops every live listing in scope and
 * withdraws every parked or live quote in scope, with exactly the code the staff Stop and Withdraw
 * buttons call, and tags the run with one batch id so `restart:stopped` can undo it.
 *
 *   npm run stop:marketplace -- --scope all --reason maintenance --note "Stock count"
 *       dry run (the default): reads, writes the report CSV, changes nothing
 *   ... --apply                   stops them, then writes the result CSV beside the plan
 *   ... --scope seller=<id>       one seller (the id in his Purchase file URL)
 *   ... --scope product=<id>      one product
 *   ... --confirm-pools           also stop listings an open pool with commitments depends on
 *   ... --by <email or id>        who the audit entries name (default: the first active Admin)
 *   ... --out <folder>            where the CSVs go (default: "trifid data/rectify-01/")
 *   ... --i-know-this-is-prod     needed unless MONGODB_URI names an allow-listed test database
 *
 * Withdrawn quotes do NOT come back with the restart: sellers re-quote and Sales gives them again.
 * Orders, payments, dispatch and Marg are untouched. Deals already offered to buyers run to the end
 * of their 24 hours.
 */
const DEFAULT_REPORT_DIR = fileURLToPath(
  new URL('../../../trifid data/rectify-01/', import.meta.url),
);

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, '--apply');
  if (apply && hasFlag(argv, '--dry-run')) throw new Error('Pass --apply or --dry-run, not both.');
  assertDatabaseAllowed(env.mongodbUri, hasFlag(argv, '--i-know-this-is-prod'));
  const scope = parseScope(argValue(argv, '--scope'));
  const reasonCode = parseReason(argValue(argv, '--reason'));
  const note = argValue(argv, '--note')?.trim();
  if (!note) throw new Error('--note "<text>" is required: say why.');
  const outDir = argValue(argv, '--out') ?? DEFAULT_REPORT_DIR;

  // A dry run must not even create a collection or an index.
  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  try {
    const plan = await planStop(scope);
    const at = stamp();
    // The report goes first: if anything below goes wrong, what was meant is already on disk.
    const planPath = writeReport(
      join(outDir, `stop-marketplace-plan-${at}.csv`),
      REPORT_COLUMNS,
      plan.rows,
    );
    const stops = plan.rows.filter((row) => row.type === 'listing' && row.action === 'stop').length;
    const skips = plan.rows.filter((row) => row.type === 'listing' && row.action === 'skip').length;
    console.log(
      `Scope ${JSON.stringify(scope)}: ${stops} listing(s) to stop, ${skips} skipped, ${plan.quoteIds.length} quote(s) to withdraw.`,
    );
    console.log(`Plan written to ${planPath}`);
    if (skips > 0) {
      console.log(
        '  Skipped: a pool that depends on the listing has a paid commitment. Settle the pool first.',
      );
    }
    if (plan.poolListingIds.length > 0) {
      console.log(
        `  ${plan.poolListingIds.length} listing(s) have an open pool with commitments (needs --confirm-pools).`,
      );
    }
    if (!apply) {
      console.log('Dry run: nothing was changed. Re-run with --apply to do it.');
      return;
    }

    const actor = await resolveActor(argValue(argv, '--by'));
    console.log(`Running as ${actor.person}.`);
    const result = await applyStop(plan, {
      reasonCode,
      note,
      employeeId: actor.employeeId,
      confirmPools: hasFlag(argv, '--confirm-pools'),
    });
    const resultPath = writeReport(
      join(outDir, `stop-marketplace-result-${at}.csv`),
      REPORT_COLUMNS,
      result.rows,
    );
    console.log(
      `Stopped ${result.listingsStopped} listing(s), withdrew ${result.quotesWithdrawn} quote(s), ${result.failures} failure(s).`,
    );
    console.log(`Result written to ${resultPath}`);
    console.log(`Batch id: ${result.stopBatchId}`);
    console.log(`To undo: npm run restart:stopped -- --batch ${result.stopBatchId} --apply`);
    console.log(
      'Note: withdrawn quotes do not come back. Sellers re-quote and Sales gives them again.',
    );
    if (result.failures > 0) process.exitCode = 1;
  } finally {
    await disconnectFromDatabase();
  }
}

run().catch(async (error: unknown) => {
  console.error('Stop marketplace failed:', error instanceof Error ? error.message : error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
