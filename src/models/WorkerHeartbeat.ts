import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Not an ENT — a technical support collection, not a business record.
 *
 * CH §25.5 — "the single highest-value alarm in the system." One document,
 * always upserted by key `'worker'`, updated every WORKER_HEARTBEAT_SECONDS
 * by the worker process. Anything that wants to know whether the worker is
 * alive reads this document's `at` field instead of talking to the worker
 * process directly.
 */
const workerHeartbeatSchema = new Schema({
  key: { type: String, required: true, unique: true, default: 'worker' },
  at: { type: Date, required: true },
});

export type WorkerHeartbeatDocument = InferSchemaType<typeof workerHeartbeatSchema>;
export const WorkerHeartbeat = model<WorkerHeartbeatDocument>(
  'WorkerHeartbeat',
  workerHeartbeatSchema,
  'worker_heartbeat',
);
