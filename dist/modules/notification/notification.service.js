import { Counterparty } from '../../models/Counterparty.js';
import { NotificationLog } from '../../models/NotificationLog.js';
import { NotificationOutbox } from '../../models/NotificationOutbox.js';
import { NotificationTemplate, } from '../../models/NotificationTemplate.js';
function maskMobile(mobile) {
    if (!mobile)
        return '—';
    return `••••••${mobile.slice(-4)}`;
}
export async function listNotificationLog(filters) {
    const query = {};
    if (filters.templateKey)
        query.templateKey = filters.templateKey;
    if (filters.outcomeCode)
        query.outcomeCode = filters.outcomeCode;
    if (filters.cursor)
        query._id = { $lt: filters.cursor };
    const rows = await NotificationLog.find(query)
        .sort({ _id: -1 })
        .limit(filters.limit + 1);
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const counterparties = await Counterparty.find({
        _id: { $in: page.map((row) => row.counterpartyId) },
    });
    const byId = new Map(counterparties.map((c) => [c._id.toString(), c]));
    const items = page.map((row) => {
        const counterparty = byId.get(row.counterpartyId.toString());
        return {
            logId: row._id.toString(),
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
        nextCursor: hasMore ? page[page.length - 1]._id.toString() : undefined,
    };
}
export async function getNotificationWorklist() {
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
    const byId = new Map(counterparties.map((c) => [c._id.toString(), c]));
    const staffQueue = queued.map((row) => {
        const counterparty = byId.get(row.counterpartyId.toString());
        return {
            outboxId: row._id.toString(),
            templateKey: row.templateKey,
            toFirm: counterparty?.firm ?? null,
            toMobileMasked: maskMobile(counterparty?.mobile),
            queuedAt: (row.staffQueuedAt ?? row.updatedAt).toISOString(),
        };
    });
    return { pausedTemplates, staffQueue };
}
/** Pulls the status updates out of Meta's nested webhook payload; ignores everything else in it. */
export function extractStatusUpdates(payload) {
    const updates = [];
    const entries = payload?.entry ?? [];
    for (const entry of entries) {
        const changes = entry.changes ?? [];
        for (const change of changes) {
            const statuses = change.value?.statuses ?? [];
            for (const item of statuses) {
                if (!item.id || !item.status)
                    continue;
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
export async function recordDeliveryStatus(update, now = new Date()) {
    const row = await NotificationOutbox.findOne({ providerMessageId: update.providerMessageId });
    if (!row)
        return; // Not ours, or already gone — nothing to update.
    if (update.status === 'delivered' || update.status === 'read') {
        // A staff-queue row that then delivers has resolved itself.
        const moved = await NotificationOutbox.updateOne({ _id: row._id, state: { $in: ['undelivered', 'staff_queue'] } }, { $set: { state: 'delivered', deliveredAt: now } });
        if (moved.modifiedCount === 0)
            return; // Already delivered — Meta sends `read` after `delivered`.
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
