import mongoose, { type ClientSession } from 'mongoose';

/**
 * TD-003 — every money write, and every write that moves a chain stage, runs
 * inside session.withTransaction(). This is the one helper every such service
 * calls, so the transaction boundary is never hand-rolled twice.
 *
 * withTransaction retries automatically on transient transaction errors; if
 * `work` throws, the transaction is aborted and nothing is committed.
 */
export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  // TypeScript cannot see that withTransaction always assigns `result` before
  // returning normally (it only returns after the callback resolves), so the
  // non-null assertion here is safe: if `work` never ran, an error is already
  // in flight and this line is unreachable.
  return result!;
}
