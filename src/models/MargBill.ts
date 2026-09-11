import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-33 `marg_bill`. BR-033/Q3b — a `query` books nothing anywhere and the
 * chain stops; there is no override field on this schema or on
 * `POST /staff/marg/:soId` (marg.controller.ts) for any role, including the
 * Controller. Never mutated in place (DATA_MODEL.md §2.2) — a re-keyed
 * correction is a new document, not an edit of this one.
 *
 * Q14 (6 Sep 2026) — **exactly one Marg invoice per SO, never consolidated**.
 * This supersedes BUSINESS_RULES.md BR-304's "one sale invoice may cover
 * several orders" on this specific point; the unique index below is the
 * enforcement. See DECISION_LOG.md.
 */
const margBillSchema = new Schema(
  {
    margInvoiceNo: { type: String, required: true },
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    margPdfRef: { type: String, default: null },
    placeOfSupply: { type: String, enum: ['intra_state', 'inter_state'], required: true },
    taxSplit: {
      cgstPaise: { type: Number, required: true },
      sgstPaise: { type: Number, required: true },
      igstPaise: { type: Number, required: true },
    },
    valuePaise: { type: Number, required: true },
    ewayNo: { type: String, required: true },
    state: { type: String, enum: ['matched', 'query'], required: true },
    keyedBy: { type: Schema.Types.ObjectId, required: true },
    keyedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

// Q14 — exactly one *matched* Marg bill per SO, never consolidated. A
// `query` does not consume this uniqueness: the operator may re-key a
// correction as a fresh document (never mutated in place, §2.2), it simply
// cannot ever become a second `matched` row for the same SO.
margBillSchema.index({ soId: 1 }, { unique: true, partialFilterExpression: { state: 'matched' } });
margBillSchema.index({ soId: 1, keyedAt: -1 });

export type MargBillDocument = InferSchemaType<typeof margBillSchema>;
export const MargBill = model<MargBillDocument>('MargBill', margBillSchema, 'marg_bill');
