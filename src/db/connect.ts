import mongoose from 'mongoose';
import { logger } from '../shared/logger.js';

/**
 * ARCHITECTURE.md §4.1 constraint 1 — MongoDB must run as a replica set (a
 * single-node replica set is acceptable in development). Multi-document
 * transactions are unavailable on a standalone server, and without them
 * INV-01, INV-06 and INV-09–INV-16 cannot be guaranteed. So: refuse to start
 * rather than run a money system without transactions.
 */
async function assertReplicaSet(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not established.');
  }
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error(
      'MongoDB is running as a standalone server, not a replica set. ' +
        'TriFid requires multi-document transactions for every money write ' +
        '(ARCHITECTURE.md §4.1) — start Mongo with --replSet and run rs.initiate(), ' +
        'or point MONGODB_URI at a replica set / Atlas cluster before starting the server.',
    );
  }
}

export async function connectToDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri);
  await assertReplicaSet();
  logger.info({ msg: 'Connected to MongoDB replica set' });
}

export async function disconnectFromDatabase(): Promise<void> {
  await mongoose.disconnect();
}
