/**
 * Creates every collection and makes its indexes match the schemas (adds missing ones, drops ones no longer
 * declared, incl. TTL and unique indexes). Safe to run repeatedly.
 *   npm run db:sync
 * Run it after pulling schema changes, and once on a new database. (Production: run it from the deploy pipeline
 * with a migrator database user, ARCH §B13.)
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import '../models/index.js';

async function main(): Promise<void> {
  await connectToDatabase(env.mongodbUri);
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
    const diff = await model.diffIndexes();
    await model.syncIndexes();
    const added = diff.toCreate.length;
    const dropped = diff.toDrop.length;
    console.log(
      `${model.collection.collectionName.padEnd(18)} ok` +
        (added || dropped ? `  (+${added} index, -${dropped} index)` : ''),
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error('db:sync failed:', error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectFromDatabase());
