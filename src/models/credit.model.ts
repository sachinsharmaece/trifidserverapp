import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  CREDIT_CHECK_RESULTS,
  CREDIT_EDIT_KINDS,
  CREDIT_EDIT_STATUSES,
  CREDIT_LINE_STATUSES,
  CREDIT_REQUEST_STATUSES,
  CREDIT_ROUTES,
  CREDIT_SUSPEND_REASONS,
  STAFF_POSITIONS,
} from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/**
 * Credit (reference FAST-ORDER LOCK-42 Part C). A buyer's credit line: how much he may owe and for how many days.
 * Set only by an approved request (an increase) or a checked Accounts edit (reduce, suspend, resume, days, cheque).
 * "Used" and "blocked" are never stored: they are worked out live from his ledger (modules/credit/credit.ts).
 */
const creditLineSchema = new Schema(
  {
    buyerId: { ...refField('Buyer'), required: true },
    limitPaise: { ...intField(0, MAX_PAISE), required: true },
    days: { type: Number, enum: [7, 15], required: true },
    status: { type: String, enum: CREDIT_LINE_STATUSES, required: true, default: 'ACTIVE' },
    suspendReason: { type: String, enum: CREDIT_SUSPEND_REASONS },
    referenceId: refField('CreditReference'),
    /** A photo of the security cheque or agreement (an UploadedFile). */
    chequeFileId: refField('UploadedFile'),
    approvedRequestId: refField('CreditRequest'),
    /** The last credit order: unused for CREDIT_UNUSED_DAYS → suspended by the daily job. */
    lastUsedAt: Date,
    /** Set by the daily job while a bill is overdue (for the log); "blocked" itself is worked out live. */
    blockedSince: Date,
  },
  { collection: 'credit_lines', timestamps: true, versionKey: false },
);
creditLineSchema.index({ buyerId: 1 }, { unique: true });
creditLineSchema.index({ referenceId: 1 });

/** A person who vouches for a buyer. The same mobile on several requests is the same reference. */
const creditReferenceSchema = new Schema(
  {
    name: { ...textField(120), required: true },
    mobile: { type: String, required: true, match: /^\d{10}$/ },
    note: textField(300),
    createdBy: refField('User'),
  },
  { collection: 'credit_references', timestamps: true, versionKey: false },
);
creditReferenceSchema.index({ mobile: 1 }, { unique: true });

const checkRowSchema = new Schema(
  {
    label: { ...textField(80), required: true },
    detail: { ...textField(300), required: true },
    result: { type: String, enum: CREDIT_CHECK_RESULTS, required: true },
  },
  { _id: false },
);

/** A request for a credit limit (a first limit or an increase), with every check it went through. */
const creditRequestSchema = new Schema(
  {
    /** CR-26-0001 */
    number: { type: String, required: true, match: /^CR-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    fromLimitPaise: { ...intField(0, MAX_PAISE), required: true },
    toLimitPaise: { ...intField(1, MAX_PAISE), required: true },
    days: { type: Number, enum: [7, 15], required: true },
    referenceId: { ...refField('CreditReference'), required: true },
    note: textField(300),
    chequeFileId: refField('UploadedFile'),
    requestedBy: { ...refField('User'), required: true },
    requestedPosition: { type: String, enum: STAFF_POSITIONS },
    /** Who approves: the requester's TM, or the Controller (always, when a check says so). */
    route: { type: String, enum: CREDIT_ROUTES, required: true },
    checks: { type: [checkRowSchema], default: [] },
    warnings: { type: [String], default: [] },
    snapshot: Schema.Types.Mixed,
    status: { type: String, enum: CREDIT_REQUEST_STATUSES, required: true, default: 'OPEN' },
    decidedBy: refField('User'),
    decidedAt: Date,
    decisionReason: textField(300),
  },
  { collection: 'credit_requests', timestamps: true, versionKey: false },
);
creditRequestSchema.index({ number: 1 }, { unique: true });
creditRequestSchema.index({ status: 1, route: 1, createdAt: 1 });
creditRequestSchema.index({ buyerId: 1, status: 1, decidedAt: -1 });

/** An Accounts change to a credit line, waiting for a second Accounts person (maker ≠ checker). */
const creditEditSchema = new Schema(
  {
    buyerId: { ...refField('Buyer'), required: true },
    kind: { type: String, enum: CREDIT_EDIT_KINDS, required: true },
    oldValue: { type: String, default: '' },
    newValue: { type: String, required: true },
    reason: { ...textField(300), required: true },
    madeBy: { ...refField('User'), required: true },
    checkedBy: refField('User'),
    checkedAt: Date,
    status: { type: String, enum: CREDIT_EDIT_STATUSES, required: true, default: 'PENDING' },
  },
  { collection: 'credit_edits', timestamps: true, versionKey: false },
);
creditEditSchema.index({ status: 1, createdAt: 1 });
creditEditSchema.index({ buyerId: 1, status: 1 });

export type CreditLine = InferSchemaType<typeof creditLineSchema>;
export const CreditLineModel = model('CreditLine', creditLineSchema);
export type CreditReference = InferSchemaType<typeof creditReferenceSchema>;
export const CreditReferenceModel = model('CreditReference', creditReferenceSchema);
export type CreditRequest = InferSchemaType<typeof creditRequestSchema>;
export const CreditRequestModel = model('CreditRequest', creditRequestSchema);
export type CreditEdit = InferSchemaType<typeof creditEditSchema>;
export const CreditEditModel = model('CreditEdit', creditEditSchema);
