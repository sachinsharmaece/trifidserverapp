import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { runAudit } from '../modules/marketplace/marketplace.audit.js';
import { argValue, assertDatabaseAllowed, hasFlag, stamp, writeReport, } from '../shared/scriptSupport.js';
/**
 * RECTIFY-01 §3.2 — the read-only data audit that comes before any fix goes live: seven checks, one
 * CSV each, so the size of every defect is known on real data before a flag is switched on.
 *
 *   npm run audit:rectify01                     (read-only; there is nothing to apply)
 *   ... --out <folder>            where the CSVs go (default: "trifid data/rectify-01/")
 *   ... --i-know-this-is-prod     needed unless MONGODB_URI names an allow-listed test database
 *
 * It writes nothing to the database, not even an index or an empty collection.
 */
const DEFAULT_REPORT_DIR = fileURLToPath(new URL('../../../trifid data/rectify-01/', import.meta.url));
async function run() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--apply'))
        throw new Error('This audit is read-only: there is nothing to --apply.');
    assertDatabaseAllowed(env.mongodbUri, hasFlag(argv, '--i-know-this-is-prod'));
    const outDir = argValue(argv, '--out') ?? DEFAULT_REPORT_DIR;
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await connectToDatabase(env.mongodbUri);
    try {
        const at = stamp();
        const { checks, ordersWithNoGstin } = await runAudit(new Date());
        for (const check of checks) {
            const path = writeReport(join(outDir, `audit-${check.key}-${at}.csv`), check.columns, check.rows);
            console.log(`${String(check.rows.length).padStart(5)}  ${check.title}\n         ${path}`);
        }
        if (ordersWithNoGstin > 0) {
            console.log(`\n${ordersWithNoGstin} intra-state order(s) belong to buyers with no GSTIN, so their state ` +
                'cannot be read; they are not in the place-of-supply CSV.');
        }
    }
    finally {
        await disconnectFromDatabase();
    }
}
run().catch(async (error) => {
    console.error('Audit failed:', error instanceof Error ? error.message : error);
    await disconnectFromDatabase();
    process.exitCode = 1;
});
