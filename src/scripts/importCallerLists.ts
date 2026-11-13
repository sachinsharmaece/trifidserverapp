import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { SALES_CALLER_POSITIONS } from '../config/positions.js';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Employee } from '../models/Employee.js';
import { Holding } from '../models/Holding.js';
import { MargBillImport } from '../models/MargBillImport.js';
import { billsFor } from '../modules/holding/holding.bills.js';
import { getSettings } from '../modules/holding/holding.settings.js';
import { ineligiblePartyIds, openGoLiveHolding } from '../modules/holding/holding.service.js';
import {
  arg,
  assertTestDatabase,
  flag,
  matchParty,
  parseCsv,
  writeReport,
  type Outcome,
} from './lock34Common.js';

/**
 * LOCK-34 step 4 — who held which party on go-live. Columns: gstin, mobile,
 * caller, where `caller` is the staff member's login (email). Matched by GSTIN,
 * then a real mobile; never by name, and a placeholder mobile never matches.
 * Creates go-live holdings (a book if the party has bills, else a lead) and
 * applies the backlog rule — so run it AFTER import:margBills.
 *
 *   npm run import:callerLists -- <file.csv> --report out.csv           dry run
 *   npm run import:callerLists -- <file.csv> --apply --report out.csv   writes
 */
async function run(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('--'))
    throw new Error('Usage: <file.csv> [--apply] [--report out.csv]');
  const apply = flag('--apply');
  assertTestDatabase(env.mongodbUri);
  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  const settings = await getSettings();
  if (!settings.goLiveDate) throw new Error('Set dormancy.goLiveDate before running this.');
  if (apply) await Holding.createIndexes();
  if ((await MargBillImport.estimatedDocumentCount()) === 0) {
    console.warn(
      'Warning: no Marg bills are loaded. Run import:margBills first, or the backlog rule has nothing to read.',
    );
  }

  const rows = parseCsv(readFileSync(file, 'utf8'));
  const callers = await Employee.find({
    active: true,
    positions: { $in: SALES_CALLER_POSITIONS },
  }).lean();
  const callerByLogin = new Map(callers.map((c) => [c.email.toLowerCase(), String(c._id)]));

  const outcomes: Outcome[] = [];
  let line = 0;
  for (const row of rows) {
    line += 1;
    const detail = `${row.gstin || row.mobile || ''} → ${row.caller ?? ''}`;
    const done = (status: Outcome['status'], why: string) =>
      outcomes.push({ line, detail, status, why });

    const holderId = callerByLogin.get((row.caller ?? '').trim().toLowerCase());
    if (!holderId) {
      done('fail', `"${row.caller}" is not an active Sales Executive or Sr. Sales Executive login`);
      continue;
    }
    const match = await matchParty(row.gstin, row.mobile);
    if (!('buyerId' in match)) {
      done('fail', match.reason);
      continue;
    }
    if (await Holding.exists({ partyId: match.buyerId, isOpen: true })) {
      done('skip', 'already has an open holding');
      continue;
    }
    if ((await ineligiblePartyIds([match.buyerId])).size > 0) {
      done('skip', 'rejected, blacklisted or deleted firm');
      continue;
    }
    if (apply) {
      await openGoLiveHolding(
        match.buyerId,
        holderId,
        settings,
        await billsFor(match.buyerId, settings.goLiveDate),
      );
    }
    done('ok', apply ? 'holding opened' : 'would open a holding');
  }
  writeReport(arg('--report'), outcomes);
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('import:callerLists failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
