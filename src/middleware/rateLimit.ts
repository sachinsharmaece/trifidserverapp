import { RateLimit } from '../models/RateLimit.js';

/**
 * Generic fixed-window counter and lockout flag, backed by Mongo (RateLimit
 * model) so limits survive a server restart and work across processes.
 *
 * ARCHITECTURE.md §8 — rate limiting is a security requirement, not a
 * business rule, so the thresholds below are a development-time technical
 * default rather than a client decision. They can move into the config
 * master (ENT-54) once a real traffic pattern is observed.
 */

// Increments the counter for `key` and returns the new count. The window
// starts on the first increment and is fixed until it expires.
export async function bumpCounter(key: string, windowSeconds: number): Promise<number> {
  const expiresAt = new Date(Date.now() + windowSeconds * 1000);
  const doc = await RateLimit.findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
    { upsert: true, new: true },
  );
  return doc.count;
}

export async function setLockout(key: string, minutes: number): Promise<void> {
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
  await RateLimit.findOneAndUpdate({ key }, { $set: { count: 1, expiresAt } }, { upsert: true });
}

export async function isLockedOut(key: string): Promise<boolean> {
  const doc = await RateLimit.findOne({ key });
  return doc !== null;
}

export async function clearCounter(key: string): Promise<void> {
  await RateLimit.deleteOne({ key });
}
