import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Runs once for the whole test run, before any test file. Starts a real,
 * single-node MongoDB replica set in memory — not a mock — so the
 * transaction and replica-set-required tests exercise the real thing
 * (ARCHITECTURE.md §4.1). Test files never touch the developer's real
 * MONGODB_URI (the Atlas cluster in .env); this replaces it for the
 * duration of the run.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri('trifid_test');
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'test-secret';
  // A developer's local .env may set this for convenience (OTP_DEV_FIXED_CODE=111111).
  // The suite must exercise real random-code generation regardless of what is
  // sitting in that file, so it is explicitly cleared here rather than left
  // to dotenv's "don't override an existing var" behaviour.
  delete process.env.OTP_DEV_FIXED_CODE;
  delete process.env.MFA_DEV_BYPASS_CODE;

  return async () => {
    await replSet.stop();
  };
}
