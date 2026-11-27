/**
 * Adds MADE-UP test data so the screens have something to show. For development only.
 *   npm run db:seed-demo
 *
 * Added now:
 *   - 12 margin cells (class A/B/C × Trader/Distributor/Dealer/Retailer), 1 Jan 2026 onwards, in the Founder's
 *     name. A pair that already has a margin is skipped.
 *   - One Rate board row to practise a deal on: Demo Seller Agency's listing of "Demo Insecticide 500 ML" at
 *     ₹500.00 per unit, and the buyer Demo Krishi Kendra (see db/seed/demoBoard.seed.ts).
 * Anything already there is skipped, so it is safe to re-run. It refuses to run when NODE_ENV=production.
 *
 * To replace a made-up margin: enter the real one on the Margin matrix screen (it starts today and takes over).
 * Margins can never be edited or deleted in the app. To remove the made-up ones completely, delete the documents
 * in `margin_cells` whose `effectiveFrom` is 2025-12-31T18:30:00.000Z (MongoDB Compass or mongosh).
 */
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { addDemoBoard } from '../db/seed/demoBoard.seed.js';
import { addDemoMargins } from '../db/seed/demoMargins.seed.js';
import { UserModel } from '../models/index.js';
async function main() {
    if (env.isProduction) {
        throw new Error('db:seed-demo adds made-up data, so it will not run when NODE_ENV=production.');
    }
    await connectToDatabase(env.mongodbUri);
    // A margin cell records who set it, so it needs a real person.
    const founder = await UserModel.findOne({ role: 'FOUNDER', active: true }).select('_id');
    if (!founder)
        throw new Error('There is no Founder account yet. Run `npm run create-founder` first.');
    const { added, skipped } = await addDemoMargins(founder._id);
    console.log(`margin cells: ${added} added, ${skipped} already present`);
    for (const line of await addDemoBoard(founder._id))
        console.log(line);
    console.log('Open the Rate board, pick "Demo Krishi Kendra" and press Open on "Demo Insecticide".');
}
main()
    .catch((error) => {
    console.error('db:seed-demo failed:', error);
    process.exitCode = 1;
})
    .finally(() => void disconnectFromDatabase());
//# sourceMappingURL=db-seed-demo.js.map