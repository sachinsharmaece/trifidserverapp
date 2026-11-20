/**
 * Loads reference data that the app needs to work. Only ADDS what is missing; never changes existing rows,
 * so it is safe to re-run and never undoes an admin's edit.
 *   npm run db:seed
 *
 * Seeded now: settings (defaults from the SRS).
 * Deliberately NOT seeded (real client data, to be imported or entered by Admin): company, HSN codes,
 * reason codes, margin cells, tehsils, products. The first staff user is created with `npm run create-founder`.
 */
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { SETTINGS_SEED } from '../db/seed/settings.seed.js';
import { SettingModel } from '../models/index.js';

async function main(): Promise<void> {
  await connectToDatabase(env.mongodbUri);

  // Validate every seed row against the schema before writing anything.
  for (const row of SETTINGS_SEED) await new SettingModel(row).validate();

  const result = await SettingModel.bulkWrite(
    SETTINGS_SEED.map((row) => ({
      updateOne: { filter: { key: row.key }, update: { $setOnInsert: row }, upsert: true },
    })),
  );
  console.log(
    `settings: ${result.upsertedCount} added, ${SETTINGS_SEED.length - result.upsertedCount} already present`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('db:seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectFromDatabase());
