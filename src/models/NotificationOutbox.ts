import { Schema, model, type InferSchemaType } from 'mongoose';
import { NOTIFICATION_LANGUAGES } from './NotificationTemplate.js';

/**
 * ENT-50 `notification_outbox`. TD-004 — written INSIDE the same transaction
 * as the business action that triggers it (`enqueueNotification`, which takes
 * the caller's session and has no session-less form). A crash between a
 * commit and a notification write therefore cannot lose the message: either
 * both exist or neither does.
 *
 * State machine (BR-292's ladder is driven off `firstAttemptAt`):
 *   queued → sending → undelivered → delivered
 *                          │  └─ +2h, still undelivered → SMS attempted (smsAttemptedAt)
 *                          └──── +4h, still undelivered → staff_queue
 *   suppressed_cap — BR-283's one-WhatsApp-per-week cap refused this row at
 *   write time; it is recorded (never silently dropped) but never sent.
 */
export const OUTBOX_STATES = [
  'queued',
  'sending',
  'undelivered',
  'delivered',
  'staff_queue',
  'suppressed_cap',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const OUTBOX_CHANNELS = ['whatsapp', 'sms'] as const;

const notificationOutboxSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    templateKey: { type: String, required: true },
    // Named placeholders only — never a free-text sentence (BR-293's spirit).
    params: { type: Schema.Types.Mixed, required: true, default: {} },
    language: { type: String, enum: NOTIFICATION_LANGUAGES, required: true },
    channel: { type: String, enum: OUTBOX_CHANNELS, required: true, default: 'whatsapp' },
    state: { type: String, enum: OUTBOX_STATES, required: true, default: 'queued' },
    attempts: { type: Number, required: true, default: 0 },
    scheduledFor: { type: Date, required: true },
    firstAttemptAt: { type: Date, default: null },
    providerMessageId: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
    smsAttemptedAt: { type: Date, default: null },
    staffQueuedAt: { type: Date, default: null },
    correlationId: { type: String, default: null },
  },
  { timestamps: true },
);

notificationOutboxSchema.index({ state: 1, scheduledFor: 1 });
notificationOutboxSchema.index({ counterpartyId: 1, createdAt: -1 });
notificationOutboxSchema.index({ providerMessageId: 1 }, { sparse: true });

export type NotificationOutboxDocument = InferSchemaType<typeof notificationOutboxSchema>;
export const NotificationOutbox = model<NotificationOutboxDocument>(
  'NotificationOutbox',
  notificationOutboxSchema,
  'notification_outbox',
);
