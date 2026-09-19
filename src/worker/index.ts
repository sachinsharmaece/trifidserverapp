import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { logger } from '../shared/logger.js';
import { writeHeartbeat } from './heartbeat.js';
import {
  JOB_CONFIRM_PILE_FANOUT,
  JOB_HEAD_START_OPEN,
  JOB_LISTING_DROPPING,
  JOB_NOTIFICATION_OUTBOX_DRAIN,
  JOB_TEMPLATE_STATUS_POLL,
} from './agendaProducer.js';
import { runConfirmPileFanout } from '../modules/demand/pileFanout.job.js';
import { runHeadStartOpen } from '../modules/demand/headStartOpen.job.js';
import { runListingDropping } from '../modules/listing/listingDropping.job.js';
import { runOutboxDrain } from '../modules/notification/notification.drain.js';
import { runTemplateStatusPoll } from '../modules/notification/notification.poll.js';

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

  // BR-137 — the deferred-commit half of a seller's pile confirm. Scheduled
  // by the API server (worker/agendaProducer.ts) 5 seconds out; an undo
  // inside that window cancels this job before it ever reaches here.
  agenda.define(JOB_CONFIRM_PILE_FANOUT, async (job: { attrs: { data?: { pileId?: string } } }) => {
    const pileId = job.attrs.data?.pileId;
    if (!pileId) return;
    await runConfirmPileFanout(pileId);
  });

  // M8 — the outbox drain (BR-292, BR-290). Sends queued WhatsApp messages and
  // runs the SMS / staff-queue escalation rungs.
  agenda.define(JOB_NOTIFICATION_OUTBOX_DRAIN, async () => {
    await runOutboxDrain();
  });

  // M8 — BR-295. Hourly template status poll; a paused template raises a worklist item.
  agenda.define(JOB_TEMPLATE_STATUS_POLL, async () => {
    await runTemplateStatusPoll();
  });

  // M8, Step 0b — BR-122. Closes out asks whose 4-working-hour head start has elapsed.
  agenda.define(JOB_HEAD_START_OPEN, async () => {
    await runHeadStartOpen();
  });

  // M8, Step 0b — BR-108. The once-per-listing "about to drop" reminder.
  agenda.define(JOB_LISTING_DROPPING, async () => {
    await runListingDropping();
  });

  agenda.on('ready', () => {
    logger.info({ msg: 'Worker process ready, agenda connected' });
  });

  await agenda.start();
  await agenda.every(`${env.workerHeartbeatSeconds} seconds`, HEARTBEAT_JOB_NAME);
  await agenda.every('1 minute', JOB_NOTIFICATION_OUTBOX_DRAIN);
  await agenda.every('1 hour', JOB_TEMPLATE_STATUS_POLL);
  await agenda.every('5 minutes', JOB_HEAD_START_OPEN);
  await agenda.every('1 day', JOB_LISTING_DROPPING);
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
