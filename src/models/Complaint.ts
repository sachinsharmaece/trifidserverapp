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

const complaintSchema = new Schema(
  {
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    category: { type: String, enum: COMPLAINT_CATEGORIES, required: true },
    note: { type: String, default: null },
    state: { type: String, enum: ['open', 'resolved'], required: true, default: 'open' },
  },
  { timestamps: true },
);

complaintSchema.index({ soId: 1 });

export type ComplaintDocument = InferSchemaType<typeof complaintSchema>;
export const Complaint = model<ComplaintDocument>('Complaint', complaintSchema, 'complaint');
