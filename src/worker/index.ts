import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { logger } from '../shared/logger.js';
import { writeHeartbeat } from './heartbeat.js';

/**
 * CH §25.2 — background work does not run inside the web framework. This is
 * a separate process (`npm run worker`), started independently of
 * server.ts, sharing models but owning every timer, run and send.
 *
 * TD-004 — queue technology: Agenda, backed by the same MongoDB replica set.
 * RECOMMENDATION — NOT A CLIENT DECISION: chosen over BullMQ/Redis so a job
 * can be enqueued inside the same transaction as the business write it
 * follows from (an outbox pattern is only safe when the queue and the
 * business data share one database) — this is TD-004's own suggested
 * default. No business jobs exist yet in M1/M2; the heartbeat is the first.
 */
const HEARTBEAT_JOB_NAME = 'worker-heartbeat';

async function startWorker(): Promise<void> {
  await connectToDatabase(env.mongodbUri);

  const agenda = new Agenda({
    backend: new MongoBackend({ address: env.mongodbUri, collection: 'agenda_jobs' }),
    processEvery: '10 seconds',
  });

  agenda.define(HEARTBEAT_JOB_NAME, async () => {
    await writeHeartbeat();
  });

  agenda.on('ready', () => {
    logger.info({ msg: 'Worker process ready, agenda connected' });
  });

  await agenda.start();
  await agenda.every(`${env.workerHeartbeatSeconds} seconds`, HEARTBEAT_JOB_NAME);
  // Write one immediately so a fresh deployment does not look stale for the
  // first WORKER_HEARTBEAT_SECONDS window.
  await writeHeartbeat();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ msg: `Worker received ${signal}, shutting down` });
    await agenda.stop();
    await disconnectFromDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startWorker().catch((error: unknown) => {
  console.error('Unable to start worker:', error);
  process.exitCode = 1;
});
