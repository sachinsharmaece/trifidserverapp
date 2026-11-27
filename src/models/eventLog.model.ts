import { Schema, model, type InferSchemaType } from 'mongoose';
import { EVENT_CATEGORIES } from '../shared/enums.js';
import { refField, textField } from './_fields.js';

/**
 * The event log (reference lib/eventlog.ts): append-only lines of who did what, when, old → new and why, grouped
 * by category (CREDIT, LISTING). The audit log (auditEvent) keeps every write; this one is what the Credit log and
 * a listing's history show. Never updated or deleted.
 */
const eventLogSchema = new Schema(
  {
    category: { type: String, enum: EVENT_CATEGORIES, required: true },
    /** The record it is about, e.g. Listing / Trade / CreditLine, and its id. */
    entityType: { ...textField(40), required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    /** The party the line is about (a buyer or seller), so a party's lines can be listed. */
    partyId: Schema.Types.ObjectId,
    action: { ...textField(60), required: true },
    /** Empty when the system did it (a clock or an automatic step). */
    userId: refField('User'),
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
    reason: textField(500),
    at: { type: Date, required: true },
  },
  { collection: 'event_logs', versionKey: false },
);

eventLogSchema.index({ category: 1, at: -1 });
eventLogSchema.index({ partyId: 1, at: -1 });
eventLogSchema.index({ entityType: 1, entityId: 1, at: 1 });

export type EventLog = InferSchemaType<typeof eventLogSchema>;
export const EventLogModel = model('EventLog', eventLogSchema);
