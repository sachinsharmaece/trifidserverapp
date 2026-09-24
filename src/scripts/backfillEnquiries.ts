import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { backfillEnquiries } from '../modules/enquiry/enquiry.backfill.js';

/**
 * DEC-051 — run once on any database that has asks or pile requests from
 * before the enquiry record existed: `npm run backfill:enquiries`.
 * Idempotent; a second run finds nothing to do.
 *
 * Orders fanned out from a pile before 23 Sep 2026 carry no `pileRequestId`,
 * so they cannot be linked to their enquiry — those enquiries read `ordered`
 * with no order shown.
 */
async function run(): Promise<void> {
  await connectToDatabase(env.mongodbUri);
  const { asks, pileRequests } = await backfillEnquiries();
  console.log(`Enquiries created: ${asks} from asks, ${pileRequests} from pile requests.`);
}

run()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('Backfill failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
  });
