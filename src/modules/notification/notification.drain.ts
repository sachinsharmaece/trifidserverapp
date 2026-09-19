import type { Types } from 'mongoose';
import { Counterparty } from '../../models/Counterparty.js';
import { NotificationLog, type NotificationOutcomeCode } from '../../models/NotificationLog.js';
import {
  NotificationOutbox,
  type NotificationOutboxDocument,
} from '../../models/NotificationOutbox.js';
import { NotificationTemplate } from '../../models/NotificationTemplate.js';
import { addHours, addMinutes } from '../../shared/clock.js';
import { logger } from '../../shared/logger.js';
import {
  getSmsSender,
  getWhatsAppTransport,
  toWhatsAppNumber,
  type WhatsAppSendResult,
} from './notification.transport.js';
import { TEMPLATE_PARAM_NAMES, type NotificationTemplateKey } from './notification.templates.js';

// BR-292 — WhatsApp immediately → SMS at two hours → staff queue at four hours.
// Both clocks run from the FIRST WhatsApp attempt, and are pure calendar hours
// (BR-230/DEC-011 — the working-hours exception is the head start alone).
export const SMS_ESCALATION_HOURS = 2;
export const STAFF_ESCALATION_HOURS = 4;

const DRAIN_BATCH_LIMIT = 100;
// A row left in `sending` this long means the worker died mid-send. Requeue it —
// a possible duplicate is a better failure than a message that never goes out.
const STUCK_SENDING_MINUTES = 5;

type OutboxRow = NotificationOutboxDocument & { _id: Types.ObjectId };

export interface DrainSummary {
  sent: number;
  smsEscalated: number;
  staffEscalated: number;
  requeued: number;
}

interface LogInput {
  row: OutboxRow;
  channel: 'whatsapp' | 'sms' | 'staff';
  deliveryStatus: 'accepted' | 'delivered' | 'failed' | 'not_sent' | 'escalated';
  outcomeCode: NotificationOutcomeCode;
  now: Date;
  httpStatus?: number | null;
  providerMessageId?: string | null;
  providerErrorCode?: string | null;
}

async function writeLog(input: LogInput): Promise<void> {
  await NotificationLog.create({
    outboxId: input.row._id,
    counterpartyId: input.row.counterpartyId,
    templateKey: input.row.templateKey,
    channel: input.channel,
    sentAt: input.now,
    deliveryStatus: input.deliveryStatus,
    outcomeCode: input.outcomeCode,
    response: {
      httpStatus: input.httpStatus ?? null,
      providerMessageId: input.providerMessageId ?? null,
      providerErrorCode: input.providerErrorCode ?? null,
    },
  });
}

/**
 * The one place a first-attempt outcome turns into a log line and a state.
 * Whatever happened — accepted, failed, not configured, no template — the row
 * becomes `undelivered` and the ladder's clocks start, because "undelivered"
 * is exactly what BR-292's later rungs are for.
 */
async function markFirstAttempt(
  row: OutboxRow,
  now: Date,
  log: Omit<LogInput, 'row' | 'channel' | 'now'>,
  providerMessageId: string | null,
): Promise<void> {
  await NotificationOutbox.updateOne(
    { _id: row._id },
    { $set: { state: 'undelivered', firstAttemptAt: now, providerMessageId } },
  );
  await writeLog({ row, channel: 'whatsapp', now, ...log });
}

function logForSendResult(result: WhatsAppSendResult): Omit<LogInput, 'row' | 'channel' | 'now'> {
  if (result.outcome === 'accepted') {
    return {
      deliveryStatus: 'accepted',
      outcomeCode: 'WA_ACCEPTED',
      httpStatus: result.httpStatus,
      providerMessageId: result.providerMessageId,
    };
  }
  if (result.outcome === 'not_configured') {
    return { deliveryStatus: 'not_sent', outcomeCode: 'WA_NOT_CONFIGURED' };
  }
  return {
    deliveryStatus: 'failed',
    outcomeCode: 'WA_API_ERROR',
    httpStatus: result.httpStatus,
    providerErrorCode: result.providerErrorCode,
  };
}

async function sendOneWhatsApp(row: OutboxRow, now: Date): Promise<void> {
  const template = await NotificationTemplate.findOne({
    key: row.templateKey,
    language: row.language,
  });
  // BR-295 — a paused/rejected/pending template is never sent, and the generic
  // fallback is never substituted automatically. The poll job's worklist item is
  // what a person acts on.
  if (!template || template.status !== 'approved') {
    await markFirstAttempt(
      row,
      now,
      { deliveryStatus: 'not_sent', outcomeCode: 'TEMPLATE_UNAVAILABLE' },
      null,
    );
    return;
  }

  const counterparty = await Counterparty.findById(row.counterpartyId);
  const toMobile = counterparty ? toWhatsAppNumber(counterparty.mobile) : null;
  if (!toMobile) {
    await markFirstAttempt(
      row,
      now,
      { deliveryStatus: 'not_sent', outcomeCode: 'NO_RECIPIENT_MOBILE' },
      null,
    );
    return;
  }

  const paramNames = TEMPLATE_PARAM_NAMES[row.templateKey as NotificationTemplateKey] ?? [];
  const params = (row.params ?? {}) as Record<string, string | number>;
  const result = await getWhatsAppTransport().send({
    toMobile,
    metaTemplateName: template.metaTemplateName,
    language: row.language,
    bodyParams: paramNames.map((name) => String(params[name] ?? '')),
  });
  await markFirstAttempt(row, now, logForSendResult(result), result.providerMessageId);
}

/** Claims one due `queued` row at a time, atomically — two workers can never send the same row. */
async function sendQueued(now: Date): Promise<number> {
  let sent = 0;
  while (sent < DRAIN_BATCH_LIMIT) {
    const row = await NotificationOutbox.findOneAndUpdate(
      { state: 'queued', scheduledFor: { $lte: now } },
      { $set: { state: 'sending' }, $inc: { attempts: 1 } },
      { new: true, sort: { scheduledFor: 1 } },
    );
    if (!row) break;
    await sendOneWhatsApp(row as unknown as OutboxRow, now);
    sent += 1;
  }
  return sent;
}

async function requeueStuckSending(now: Date): Promise<number> {
  const result = await NotificationOutbox.updateMany(
    { state: 'sending', updatedAt: { $lte: addMinutes(now, -STUCK_SENDING_MINUTES) } },
    { $set: { state: 'queued' } },
  );
  return result.modifiedCount;
}

/** BR-292 — SMS at two hours if still undelivered. The SMS itself is a stub (QR-023). */
async function escalateToSms(now: Date): Promise<number> {
  let escalated = 0;
  while (escalated < DRAIN_BATCH_LIMIT) {
    const row = await NotificationOutbox.findOneAndUpdate(
      {
        state: 'undelivered',
        smsAttemptedAt: null,
        firstAttemptAt: { $lte: addHours(now, -SMS_ESCALATION_HOURS) },
      },
      { $set: { smsAttemptedAt: now, channel: 'sms' } },
      { new: true, sort: { firstAttemptAt: 1 } },
    );
    if (!row) break;
    const outboxRow = row as unknown as OutboxRow;

    const counterparty = await Counterparty.findById(outboxRow.counterpartyId);
    const result = await getSmsSender().send({
      toMobile: counterparty?.mobile ?? '',
      templateKey: outboxRow.templateKey,
      params: (outboxRow.params ?? {}) as Record<string, string | number>,
    });
    await writeLog({
      row: outboxRow,
      channel: 'sms',
      now,
      deliveryStatus: result.outcome === 'accepted' ? 'accepted' : 'not_sent',
      outcomeCode:
        result.outcome === 'accepted'
          ? 'SMS_ACCEPTED'
          : result.outcome === 'api_error'
            ? 'SMS_API_ERROR'
            : 'SMS_STUB_NOT_SENT',
      providerErrorCode: result.providerErrorCode,
    });
    escalated += 1;
  }
  return escalated;
}

/** BR-292 — the staff queue at four hours if still undelivered. */
async function escalateToStaff(now: Date): Promise<number> {
  let escalated = 0;
  while (escalated < DRAIN_BATCH_LIMIT) {
    const row = await NotificationOutbox.findOneAndUpdate(
      {
        state: 'undelivered',
        staffQueuedAt: null,
        firstAttemptAt: { $lte: addHours(now, -STAFF_ESCALATION_HOURS) },
      },
      { $set: { state: 'staff_queue', staffQueuedAt: now } },
      { new: true, sort: { firstAttemptAt: 1 } },
    );
    if (!row) break;
    await writeLog({
      row: row as unknown as OutboxRow,
      channel: 'staff',
      now,
      deliveryStatus: 'escalated',
      outcomeCode: 'ESCALATED_TO_STAFF',
    });
    escalated += 1;
  }
  return escalated;
}

/**
 * The 1-minute outbox drain (WORKFLOWS.md §3, BR-292). Runs in the worker
 * process, never the web framework (CH §25.2). Idempotent, and every row is
 * claimed with one atomic update, so overlapping runs cannot double-send.
 * `now` is a parameter so the ladder's two- and four-hour rungs are testable
 * without waiting.
 */
export async function runOutboxDrain(now: Date = new Date()): Promise<DrainSummary> {
  const requeued = await requeueStuckSending(now);
  const sent = await sendQueued(now);
  const smsEscalated = await escalateToSms(now);
  const staffEscalated = await escalateToStaff(now);
  if (sent + smsEscalated + staffEscalated + requeued > 0) {
    logger.info({ msg: 'Outbox drain ran', sent, smsEscalated, staffEscalated, requeued });
  }
  return { sent, smsEscalated, staffEscalated, requeued };
}
