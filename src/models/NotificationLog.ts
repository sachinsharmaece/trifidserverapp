import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-51 `notification_log` (the SSOT's second `ENT-51` — see DATA_MODEL.md).
 * BR-293 — every attempt logs channel, timestamp, delivery status and
 * response. **Outcome codes are a fixed list, never free text** (CH §21.6, §27.2).
 *
 * `response` is deliberately structured (HTTP status, the provider's message
 * id, the provider's error code) rather than a pasted message string.
 */
export const NOTIFICATION_OUTCOME_CODES = [
  'WA_ACCEPTED', //           Meta accepted the message.
  'WA_DELIVERED', //          Meta reported it delivered.
  'WA_DELIVERY_FAILED', //    Meta reported a delivery failure.
  'WA_API_ERROR', //          The send call itself failed.
  'WA_NOT_CONFIGURED', //     No WhatsApp credentials — nothing was sent (dev/test).
  'TEMPLATE_UNAVAILABLE', //  The template was not approved, so nothing was sent (BR-295).
  'NO_RECIPIENT_MOBILE', //   The counterparty has no usable mobile number.
  'SMS_STUB_NOT_SENT', //     BR-292's SMS step ran, but SMS is a stub until DLT registration (QR-023).
  'SMS_ACCEPTED', //          Reserved for the real SMS provider.
  'SMS_API_ERROR', //         Reserved for the real SMS provider.
  'ESCALATED_TO_STAFF', //    BR-292's four-hour step: the message is now a staff-queue item.
  'CAP_SUPPRESSED', //        BR-283's weekly cap refused the WhatsApp send.
] as const;
export type NotificationOutcomeCode = (typeof NOTIFICATION_OUTCOME_CODES)[number];

export const DELIVERY_STATUSES = [
  'accepted',
  'delivered',
  'failed',
  'not_sent',
  'escalated',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const notificationLogSchema = new Schema(
  {
    outboxId: { type: Schema.Types.ObjectId, ref: 'NotificationOutbox', required: true },
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    templateKey: { type: String, required: true },
    channel: { type: String, enum: ['whatsapp', 'sms', 'staff'], required: true },
    sentAt: { type: Date, required: true, default: () => new Date() },
    deliveryStatus: { type: String, enum: DELIVERY_STATUSES, required: true },
    response: {
      httpStatus: { type: Number, default: null },
      providerMessageId: { type: String, default: null },
      providerErrorCode: { type: String, default: null },
    },
    outcomeCode: { type: String, enum: NOTIFICATION_OUTCOME_CODES, required: true },
  },
  { timestamps: true },
);

notificationLogSchema.index({ sentAt: -1 });
notificationLogSchema.index({ counterpartyId: 1, sentAt: -1 });
notificationLogSchema.index({ outboxId: 1 });

export type NotificationLogDocument = InferSchemaType<typeof notificationLogSchema>;
export const NotificationLog = model<NotificationLogDocument>(
  'NotificationLog',
  notificationLogSchema,
  'notification_log',
);
