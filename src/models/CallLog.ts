import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Sales desk v2 (work-stream A) `call_log`. Every phone conversation Sales
 * has with a buyer: why it happened, and what came of it. Three kinds —
 * `call` (a conversation with an outcome), `note` (something added after
 * the fact, no outcome), `update_request` (the buyer asked to change
 * something on file, e.g. his mobile or delivery address). Which fields are
 * required for which kind is a business rule, not a storage constraint, so
 * it is enforced in sales.validation.ts (zod) and re-checked in
 * sales.calls.ts's `createCallLog` — never here, where a Mongoose validation
 * error would carry a raw field name instead of a plain-English message.
 */
export const CALL_OUTCOMES = [
  'placed_an_order',
  'asked_for_a_rate',
  'wants_something_we_dont_stock',
  'rate_too_high',
  'already_holds_stock',
  'buys_direct_from_company',
  'not_now_call_later',
  'no_answer',
  'wrong_number',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_LOG_KINDS = ['call', 'note', 'update_request'] as const;
export type CallLogKind = (typeof CALL_LOG_KINDS)[number];

export const CALL_LOG_UPDATE_KINDS = [
  'mobile',
  'delivery_address',
  'dealerships',
  'reclassify_request',
  'gst_details',
] as const;
export type CallLogUpdateKind = (typeof CALL_LOG_UPDATE_KINDS)[number];

const callLogSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    direction: { type: String, enum: ['in', 'out'], default: null },
    at: { type: Date, required: true, default: () => new Date() },
    kind: { type: String, enum: CALL_LOG_KINDS, required: true },
    outcome: { type: String, enum: CALL_OUTCOMES, default: null },
    note: { type: String, required: true },
    producedAskId: { type: Schema.Types.ObjectId, ref: 'Ask', default: null },
    listingLineId: { type: Schema.Types.ObjectId, ref: 'ListingLine', default: null },
    updateKind: { type: String, enum: CALL_LOG_UPDATE_KINDS, default: null },
    updateValue: { type: String, default: null },
    promiseDueAt: { type: Date, default: null },
    promiseFulfilledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The buyer file's call history, newest first.
callLogSchema.index({ buyerId: 1, at: -1 });
// The Today worklist's "Promised" bucket — every open promise, soonest due first.
callLogSchema.index({ promiseDueAt: 1, promiseFulfilledAt: 1 });

export type CallLogDocument = InferSchemaType<typeof callLogSchema>;
export const CallLog = model<CallLogDocument>('CallLog', callLogSchema, 'call_log');
