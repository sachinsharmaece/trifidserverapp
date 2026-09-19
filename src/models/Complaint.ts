import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New — API-074/BR-201. Five fixed intake categories; nothing free-text
 * drives the resolution direction (only `note` is free text, kept for a
 * human to read, never parsed).
 */
export const COMPLAINT_CATEGORIES = [
  'transit_damage',
  'hidden_defect_sealed_case',
  'wrong_declared_by_seller',
  'wrong_missed_by_dock',
  'short_count_on_arrival',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

// New — M7, BR-206: "Controller decides disputes." A decision assigns fault;
// downstream execution (Purchase recovering from a seller, Sales carrying
// the outcome back to the buyer) reads this, never decides it independently.
// `transit_damage` never reaches a decision this session (QR-050) — see
// `modules/desk/sales/sales.service.ts`'s routing table.
export const COMPLAINT_DISPOSITIONS = ['seller_fault', 'dock_fault', 'no_fault'] as const;
export type ComplaintDisposition = (typeof COMPLAINT_DISPOSITIONS)[number];

const complaintSchema = new Schema(
  {
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    category: { type: String, enum: COMPLAINT_CATEGORIES, required: true },
    note: { type: String, default: null },
    state: { type: String, enum: ['open', 'resolved'], required: true, default: 'open' },
    disposition: { type: String, enum: COMPLAINT_DISPOSITIONS, default: null },
    decidedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },
    debitNoteId: { type: Schema.Types.ObjectId, ref: 'DebitNote', default: null },
  },
  { timestamps: true },
);

complaintSchema.index({ soId: 1 });

export type ComplaintDocument = InferSchemaType<typeof complaintSchema>;
export const Complaint = model<ComplaintDocument>('Complaint', complaintSchema, 'complaint');
