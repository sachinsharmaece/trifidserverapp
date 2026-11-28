import { Schema, model, type InferSchemaType } from 'mongoose';
import { SELL_LEAD_SOURCES, SELL_LEAD_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * A seller lead (reference LOCK-39 Part B, SellLead + SellLeadEvent): a firm (one of our buyers) that also has stock
 * to sell. Sales pushes it ("Push to purchase") or Purchase adds it by hand; Purchase claims, contacts, accepts,
 * onboards him as a seller, or rejects it with a reason. One open lead per firm and product. "Past SLA" (no first
 * action by `dueAt`) is worked out, never stored.
 */
const leadEventSchema = new Schema(
  {
    kind: { ...textField(30), required: true },
    fromStatus: { type: String, enum: SELL_LEAD_STATUSES },
    toStatus: { type: String, enum: SELL_LEAD_STATUSES, required: true },
    note: textField(500),
    by: { ...refField('User'), required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const sellLeadSchema = new Schema(
  {
    firmId: { ...refField('Buyer'), required: true },
    skuId: refField('Sku'),
    productText: { ...textField(200), required: true },
    approxQty: intField(1, 10_000_000),
    qtyUnit: textField(20),
    expectedRatePaisePerUnit: intField(1, 100_000_000),
    note: { ...textField(500), required: true },
    source: { type: String, enum: SELL_LEAD_SOURCES, required: true },
    pushedBy: { ...refField('User'), required: true },
    status: { type: String, enum: SELL_LEAD_STATUSES, required: true, default: 'NEW' },
    ownerUserId: refField('User'),
    rejectCode: textField(60),
    rejectNote: textField(500),
    /** The seller made from this lead (ONBOARDED). */
    sellerId: refField('Seller'),
    dueAt: { type: Date, required: true },
    firstActionAt: Date,
    closedAt: Date,
    events: { type: [leadEventSchema], default: [] },
  },
  { collection: 'sell_leads', timestamps: true, versionKey: false },
);

sellLeadSchema.index({ firmId: 1, status: 1 });
sellLeadSchema.index({ createdAt: -1 });
sellLeadSchema.index({ pushedBy: 1, createdAt: -1 });

export type SellLead = InferSchemaType<typeof sellLeadSchema>;
export const SellLeadModel = model('SellLead', sellLeadSchema);
