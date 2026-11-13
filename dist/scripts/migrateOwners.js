import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { BookAssignment } from '../models/BookAssignment.js';
import { Employee } from '../models/Employee.js';
import { Holding } from '../models/Holding.js';
import { billsForMany } from '../modules/holding/holding.bills.js';
import { getSettings } from '../modules/holding/holding.settings.js';
import { ineligiblePartyIds, openGoLiveHolding } from '../modules/holding/holding.service.js';
import { arg, assertTestDatabase, flag, writeReport } from './lock34Common.js';
/**
 * LOCK-34 step 2 — turns today's owner/book/queue field (`book_assignment`) into
 * go-live holdings. An owner set: a book if the buyer has bills, otherwise a
 * lead. No owner (the Queue): he is in the Pool, so nothing is written.
 *
 *   npm run migrate:owners -- --report out.csv            dry run: writes nothing
 *   npm run migrate:owners -- --apply --report out.csv    writes the holdings
 *
 * Needs `dormancy.goLiveDate` to be set. Safe to run twice: a buyer who already
 * has an open holding is skipped.
 */
async function run() {
    const apply = flag('--apply');
    assertTestDatabase(env.mongodbUri);
    if (!apply) {
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
    }
    await connectToDatabase(env.mongodbUri);
    const settings = await getSettings();
    if (!settings.goLiveDate)
        throw new Error('Set dormancy.goLiveDate before running this.');
    if (apply)
        await Holding.createIndexes();
    const assignments = await BookAssignment.find().lean();
    const partyIds = assignments.map((a) => String(a.buyerId));
    const [bills, bad, held, owners] = await Promise.all([
        billsForMany(partyIds, settings.goLiveDate),
        ineligiblePartyIds(partyIds),
        Holding.find({ partyId: { $in: partyIds }, isOpen: true }, { partyId: 1 }).lean(),
        Employee.find({ _id: { $in: assignments.map((a) => a.ownerEmployeeId) } }, { active: 1 }).lean(),
    ]);
    const alreadyHeld = new Set(held.map((h) => String(h.partyId)));
    const ownerActive = new Map(owners.map((o) => [String(o._id), o.active]));
    const outcomes = [];
    let line = 0;
    for (const a of assignments) {
        line += 1;
        const party = String(a.buyerId);
        const detail = `buyer ${party}`;
        const done = (status, why) => outcomes.push({ line, detail, status, why });
        if (alreadyHeld.has(party)) {
            done('skip', 'already has an open holding');
            continue;
        }
        if (bad.has(party)) {
            done('skip', 'rejected, blacklisted or deleted firm');
            continue;
        }
        if (!ownerActive.get(String(a.ownerEmployeeId))) {
            done('skip', 'the owner is not an active employee — reassign him first');
            continue;
        }
        const partyBills = bills.get(party) ?? [];
        const kind = partyBills.length > 0 ? 'book' : 'lead';
        if (apply)
            await openGoLiveHolding(party, String(a.ownerEmployeeId), settings, partyBills);
        done('ok', apply ? `holding opened (${kind})` : `would open a ${kind}`);
    }
    writeReport(arg('--report'), outcomes);
    await disconnectFromDatabase();
}
run().catch(async (error) => {
    console.error('migrate:owners failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
});
