import { WorkerHeartbeat } from '../models/WorkerHeartbeat.js';

export async function writeHeartbeat(): Promise<void> {
  await WorkerHeartbeat.findOneAndUpdate(
    { key: 'worker' },
    { $set: { at: new Date() } },
    { upsert: true },
  );
}

/**
 * Read by the Express health endpoint (routes/health.ts) — a dead worker
 * throws no error and serves no 500 on its own (CH §25.5), so the *server*
 * is what surfaces the staleness, not the worker.
 */
export async function getHeartbeatAgeSeconds(): Promise<number | null> {
  const doc = await WorkerHeartbeat.findOne({ key: 'worker' });
  if (!doc) return null;
  return Math.floor((Date.now() - doc.at.getTime()) / 1000);
}
