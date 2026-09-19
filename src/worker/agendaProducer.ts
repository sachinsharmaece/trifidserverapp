import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { env } from '../config/env.js';

/**
 * TD-004 — "an enqueue can join the same transaction as the business write
 * it follows from" only holds because the queue and the business data share
 * one MongoDB. This is the API server's side of that: a producer-only
 * Agenda instance (never `.start()`ed, so it never processes jobs itself)
 * used to schedule and cancel jobs that `worker/index.ts` actually runs.
 *
 * BR-137 — "implement as a deferred commit (schedule 5s out, cancellable),
 * not as a reversal" is what this exists for: `modules/demand`'s pile
 * confirm schedules the real fan-out here instead of running it inline, so
 * an undo within the window cancels a job that never ran rather than
 * reversing one that did.
 */
let producer: Agenda | null = null;

export function getAgendaProducer(): Agenda {
  if (!producer) {
    producer = new Agenda({
      backend: new MongoBackend({ address: env.mongodbUri, collection: 'agenda_jobs' }),
    });
  }
  return producer;
}

export const JOB_CONFIRM_PILE_FANOUT = 'confirm-pile-fanout';

// M8 — recurring jobs, registered by worker/index.ts. Only these four are wired;
// the other jobs listed in WORKFLOWS.md §3 remain manual actions on purpose.
export const JOB_NOTIFICATION_OUTBOX_DRAIN = 'notification-outbox-drain'; // 1 min — BR-292
export const JOB_TEMPLATE_STATUS_POLL = 'notification-template-status-poll'; // hourly — BR-295
export const JOB_HEAD_START_OPEN = 'head-start-open'; // 5 min — BR-122
export const JOB_LISTING_DROPPING = 'listing-dropping'; // daily — BR-108
