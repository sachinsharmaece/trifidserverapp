import type { Types } from 'mongoose';
import { Counterparty } from '../../models/Counterparty.js';
import { NotificationLog } from '../../models/NotificationLog.js';
import { NotificationOutbox } from '../../models/NotificationOutbox.js';
import {
  NotificationTemplate,
  type NotificationLanguage,
  type TemplateStatus,
} from '../../models/NotificationTemplate.js';

// ---------------------------------------------------------------------------
// The notification log view — a read screen for debugging delivery. Not a
// management console: nothing here sends, retries or edits anything.
// ---------------------------------------------------------------------------

export interface NotificationLogItem {
  logId: string;
  sentAt: string;
  templateKey: string;
  channel: string;
  deliveryStatus: string;
  outcomeCode: string;
  toFirm: string | null;
  toMobileMasked: string; // Last four digits only — enough to tell two firms apart on a call.
  httpStatus: number | null;
  providerErrorCode: string | null;
}

export interface NotificationLogFilters {
  templateKey?: string;
  outcomeCode?: string;
  cursor?: string;
  limit: number;
}

function maskMobile(mobile: string | undefined): string {
  if (!mobile) return '—';
  return `••••••${mobile.slice(-4)}`;
}

export async function listNotificationLog(
  filters: NotificationLogFilters,
): Promise<{ items: NotificationLogItem[]; nextCursor?: string }> {
  const query: Record<string, unknown> = {};
  if (filters.templateKey) query.templateKey = filters.templateKey;
  if (filters.outcomeCode) query.outcomeCode = filters.outcomeCode;
  if (filters.cursor) query._id = { $lt: filters.cursor };

  const rows = await NotificationLog.find(query)
    .sort({ _id: -1 })
    .limit(filters.limit + 1);
  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  const counterparties = await Counterparty.find({
    _id: { $in: page.map((row) => row.counterpartyId) },
  });
  const byId = new Map(counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c]));

  const items = page.map((row) => {
    const counterparty = byId.get(row.counterpartyId.toString());
    return {
      logId: (row._id as Types.ObjectId).toString(),
      sentAt: row.sentAt.toISOString(),
      templateKey: row.templateKey,
      channel: row.channel,
      deliveryStatus: row.deliveryStatus,
      outcomeCode: row.outcomeCode,
      toFirm: counterparty?.firm ?? null,
      toMobileMasked: maskMobile(counterparty?.mobile),
      httpStatus: row.response?.httpStatus ?? null,
      providerErrorCode: row.response?.providerErrorCode ?? null,
    };
  });

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]!._id as Types.ObjectId).toString() : undefined,
  };
}

// ---------------------------------------------------------------------------
// The worklist — BR-295's paused template, and BR-292's four-hour staff queue.
// Both are derived from live data, so an item exists exactly as long as the
// problem does and clears itself when the problem does. No separate worklist
// collection exists to drift out of step.
// ---------------------------------------------------------------------------

export interface PausedTemplateItem {
  templateKey: string;
  language: NotificationLanguage;
  metaTemplateName: string;
  status: TemplateStatus;
  since: string | null;
}

export interface StaffQueueItem {
  outboxId: string;
  templateKey: string;
  toFirm: string | null;
  toMobileMasked: string;
  queuedAt: string;
}

export interface NotificationWorklist {
  pausedTemplates: PausedTemplateItem[];
  staffQueue: StaffQueueItem[];
}

export async function getNotificationWorklist(): Promise<NotificationWorklist> {
  const unusable = await NotificationTemplate.find({
    status: { $in: ['paused', 'rejected'] },
  }).sort({
    statusChangedAt: 1,
  });
  const pausedTemplates = unusable.map((t) => ({
    templateKey: t.key,
    language: t.language,
    metaTemplateName: t.metaTemplateName,
    status: t.status,
    since: t.statusChangedAt ? t.statusChangedAt.toISOString() : null,
  }));

  const queued = await NotificationOutbox.find({ state: 'staff_queue' }).sort({ staffQueuedAt: 1 });
  const counterparties = await Counterparty.find({
    _id: { $in: queued.map((row) => row.counterpartyId) },
  });
  const byId = new Map(counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c]));
  const staffQueue = queued.map((row) => {
    const counterparty = byId.get(row.counterpartyId.toString());
    return {
      outboxId: (row._id as Types.ObjectId).toString(),
      templateKey: row.templateKey,
      toFirm: counterparty?.firm ?? null,
      toMobileMasked: maskMobile(counterparty?.mobile),
      queuedAt: (row.staffQueuedAt ?? row.updatedAt).toISOString(),
    };
  });

  return { pausedTemplates, staffQueue };
}

// ---------------------------------------------------------------------------
// Meta's delivery-status callbacks. Without these nothing would ever leave
// `undelivered`, and every message would run the whole escalation ladder.
// ---------------------------------------------------------------------------

export interface WhatsAppStatusUpdate {
  providerMessageId: string;
  status: string; // Meta's own words: sent | delivered | read | failed
  errorCode?: string;
}

/** Pulls the status updates out of Meta's nested webhook payload; ignores everything else in it. */
export function extractStatusUpdates(payload: unknown): WhatsAppStatusUpdate[] {
  const updates: WhatsAppStatusUpdate[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] }).changes ?? [];
    for (const change of changes) {
      const statuses =
        (
          change as {
            value?: {
              statuses?: Array<{ id?: string; status?: string; errors?: Array<{ code?: number }> }>;
            };
          }
        ).value?.statuses ?? [];
      for (const item of statuses) {
        if (!item.id || !item.status) continue;
        const errorCode = item.errors?.[0]?.code;
        updates.push({
          providerMessageId: item.id,
          status: item.status,
          ...(errorCode !== undefined ? { errorCode: String(errorCode) } : {}),
        });
      }
    }
  }
  return updates;
}

/** Records one delivery-status callback against the outbox row it belongs to. */
export async function recordDeliveryStatus(
  update: WhatsAppStatusUpdate,
  now: Date = new Date(),
): Promise<void> {
  const row = await NotificationOutbox.findOne({ providerMessageId: update.providerMessageId });
  if (!row) return; // Not ours, or already gone — nothing to update.

  if (update.status === 'delivered' || update.status === 'read') {
    // A staff-queue row that then delivers has resolved itself.
    const moved = await NotificationOutbox.updateOne(
      { _id: row._id, state: { $in: ['undelivered', 'staff_queue'] } },
      { $set: { state: 'delivered', deliveredAt: now } },
    );
    if (moved.modifiedCount === 0) return; // Already delivered — Meta sends `read` after `delivered`.
    await NotificationLog.create({
      outboxId: row._id,
      counterpartyId: row.counterpartyId,
      templateKey: row.templateKey,
      channel: 'whatsapp',
      sentAt: now,
      deliveryStatus: 'delivered',
      outcomeCode: 'WA_DELIVERED',
      response: { providerMessageId: update.providerMessageId },
    });
    return;
  }

  if (update.status === 'failed') {
    await NotificationLog.create({
      outboxId: row._id,
      counterpartyId: row.counterpartyId,
      templateKey: row.templateKey,
      channel: 'whatsapp',
      sentAt: now,
      deliveryStatus: 'failed',
      outcomeCode: 'WA_DELIVERY_FAILED',
      response: {
        providerMessageId: update.providerMessageId,
        providerErrorCode: update.errorCode ?? null,
      },
    });
    // The row stays `undelivered` on purpose — BR-292's SMS and staff rungs are
    // exactly what a failed delivery is meant to reach.
  }
}
