import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import {
  applyRestart,
  planRestart,
  resolveActor,
} from '../modules/marketplace/marketplace.bulk.js';
import { getListingImpact } from '../modules/marketplace/marketplace.service.js';
import {
  argValue,
  assertDatabaseAllowed,
  hasFlag,
  stamp,
  writeReport,
} from '../shared/scriptSupport.js';

/**
 * RECTIFY-01 Phase 0 — undo one `stop:marketplace` run. Restarts only the listings that batch
 * stopped and that are still stopped by staff, each with a fresh 45-day window. A listing the seller
 * paused himself is never touched.
 *
 *   npm run restart:stopped -- --batch <id>             dry run (the default): lists them
 *   npm run restart:stopped -- --batch <id> --apply     restarts them
 *   ... --by <email or id>   --out <folder>   --i-know-this-is-prod   (as for stop:marketplace)
 *
 * WITHDRAWN QUOTES DO NOT COME BACK. Sellers re-quote and Sales gives them again.
 */
const DEFAULT_REPORT_DIR = fileURLToPath(
  new URL('../../../trifid data/rectify-01/', import.meta.url),
);
const COLUMNS = ['listingId', 'seller', 'product', 'outcome'] as const;

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, '--apply');
  const batch = argValue(argv, '--batch');
  if (!batch) throw new Error('--batch <id> is required (printed by stop:marketplace --apply).');
  assertDatabaseAllowed(env.mongodbUri, hasFlag(argv, '--i-know-this-is-prod'));
  const outDir = argValue(argv, '--out') ?? DEFAULT_REPORT_DIR;

  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  try {
    const at = stamp();
    const listings = await planRestart(batch);
    const planned = [];
    for (const listing of listings) {
      const impact = await getListingImpact(listing);
      planned.push({
        listingId: String(listing._id),
        seller: impact.listing.sellerFirm,
        product: impact.listing.product,
        outcome: 'to restart',
      });
    }
    const planPath = writeReport(join(outDir, `restart-stopped-plan-${at}.csv`), COLUMNS, planned);
    console.log(`Batch ${batch}: ${planned.length} listing(s) still stopped by staff.`);
    console.log(`Plan written to ${planPath}`);
    console.log('Withdrawn quotes do not come back: sellers re-quote and Sales gives them again.');
    if (!apply) {
      console.log('Dry run: nothing was changed. Re-run with --apply to restart them.');
      return;
    }
    const actor = await resolveActor(argValue(argv, '--by'));
    const rows = await applyRestart(batch, {
      employeeId: actor.employeeId,
      correlationId: `restart-batch-${batch}`,
    });
    const resultPath = writeReport(join(outDir, `restart-stopped-result-${at}.csv`), COLUMNS, rows);
    const restarted = rows.filter((row) => row.outcome === 'restarted').length;
    console.log(`Restarted ${restarted} of ${rows.length} listing(s).`);
    console.log(`Result written to ${resultPath}`);
    if (restarted < rows.length) process.exitCode = 1;
  } finally {
    await disconnectFromDatabase();
  }
}

run().catch(async (error: unknown) => {
  console.error('Restart stopped failed:', error instanceof Error ? error.message : error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
