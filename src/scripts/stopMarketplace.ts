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
 *   ... --confirm-pools           also stop listings whose seller supplies a pool someone is committed to
 *   ... --confirm-paid-pools      on top of that, also stop the ones where a commitment is already paid
 *                                 (the Admins get a notice naming the pools to settle with their buyers)
 *   ... --by <email or id>        who the audit entries name (default: the first active Admin)
 *   ... --out <folder>            where the CSVs go (default: "trifid data/rectify-01/")
 *   ... --i-know-this-is-prod     needed unless MONGODB_URI names an allow-listed test database
 *
 * Withdrawn quotes do NOT come back with the restart: sellers re-quote and Sales gives them again.
 * Orders, payments, dispatch and Marg are untouched. Deals already offered to buyers run to the end
 * of their 24 hours.
 *
 * A listing the run does not stop is SKIPPED, never silently: it is printed by id, seller and product,
 * marked in the CSV, and the command exits non-zero. A run that leaves a listing live has not done
 * what was asked.
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
    const confirmPaidPools = hasFlag(argv, '--confirm-paid-pools');
    const plan = await planStop(scope, { confirmPaidPools });
    const at = stamp();
    // The report goes first: if anything below goes wrong, what was meant is already on disk.
    const planPath = writeReport(
      join(outDir, `stop-marketplace-plan-${at}.csv`),
      REPORT_COLUMNS,
      plan.rows,
    );
    const stops = plan.rows.filter((row) => row.type === 'listing' && row.action === 'stop').length;
    const skipped = plan.rows.filter((row) => row.type === 'listing' && row.action === 'skip');
    console.log(
      `Scope ${JSON.stringify(scope)}: ${stops} listing(s) to stop, ${skipped.length} skipped, ${plan.quoteIds.length} quote(s) to withdraw.`,
    );
    console.log(`Plan written to ${planPath}`);
    if (skipped.length > 0) {
      console.error(
        `\nSKIPPED — ${skipped.length} listing(s) will stay LIVE. A pool each seller supplies has a paid commitment:`,
      );
      for (const row of skipped) {
        console.error(`  ${row.id}  ${row.seller} — ${row.product}`);
      }
      console.error(
        'Settle those pools with their buyers, or re-run with --confirm-pools --confirm-paid-pools (Admin).\n',
      );
      process.exitCode = 1;
    }
    const needPools = plan.poolListingIds.filter((listingId) =>
      plan.listingIds.includes(listingId),
    );
    if (needPools.length > 0) {
      console.log(
        `  ${needPools.length} listing(s) are supplying a pool with commitments (needs --confirm-pools).`,
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
      confirmPaidPools,
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
    if (result.listingsSkipped > 0) {
      console.error(`${result.listingsSkipped} listing(s) were SKIPPED and are still live:`);
      for (const row of result.rows.filter(
        (r) => r.type === 'listing' && r.outcome === 'skipped',
      )) {
        console.error(`  ${row.id}  ${row.seller} — ${row.product}`);
      }
    }
    if (result.failures > 0 || result.listingsSkipped > 0) process.exitCode = 1;
  } finally {
    await disconnectFromDatabase();
  }
}

run().catch(async (error: unknown) => {
  console.error('Stop marketplace failed:', error instanceof Error ? error.message : error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
