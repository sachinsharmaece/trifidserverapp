import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import {
  migrateLocationMasters,
  rollbackLocationMigration,
  type LocationMigrationReport,
} from '../modules/territory/territory.migration.js';

/**
 * Phase 1 — links every tehsil to the State and District masters
 * (modules/territory/territory.migration.ts explains the rules).
 *
 *   npm run migrate:locationMasters                 dry run: prints the report, writes nothing
 *   npm run migrate:locationMasters -- --apply      does it (backs up each changed tehsil first)
 *   npm run migrate:locationMasters -- --rollback   restores the backed-up tehsils
 *
 * Read the dry run before applying — especially "conflicts" and "suspected
 * duplicates", which are for a person to decide; the script never merges or
 * deletes. Running --apply again changes nothing.
 */
function print(report: LocationMigrationReport): void {
  const section = (title: string, lines: string[]) => {
    console.log(`\n${title} (${lines.length})`);
    for (const line of lines) console.log(`  - ${line}`);
  };
  console.log(`Location masters migration — ${report.mode}`);
  console.log(`Tehsils scanned: ${report.tehsilsScanned}; already linked: ${report.alreadyLinked}`);
  section(
    report.mode === 'apply' ? 'Linked' : 'Would link',
    report.linked.map((l) => `${l.tehsil}: "${l.from}" → ${l.to}`),
  );
  section(
    report.mode === 'apply' ? 'Districts created' : 'Would create districts',
    report.districtsCreated,
  );
  section(
    'State not recognised — left unlinked',
    report.unknownState.map((u) => `${u.tehsil} (${u.district}): state "${u.state}"`),
  );
  section(
    'Conflicts — left unlinked',
    report.conflicts.map((c) => `${c.tehsil} → ${c.district}: ${c.reason}; kept ${c.keptTehsil}`),
  );
  section(
    'Suspected duplicates — for a person to decide',
    report.suspectedDuplicates.map((d) => `${d.place}: ${d.names.join(' / ')} — ${d.reason}`),
  );
}

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const rollback = process.argv.includes('--rollback');
  await connectToDatabase(env.mongodbUri);
  if (rollback) {
    const { restored } = await rollbackLocationMigration();
    console.log(`Rolled back: ${restored} tehsil(s) restored to their original text.`);
  } else {
    print(await migrateLocationMasters({ apply }));
  }
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Location masters migration failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
