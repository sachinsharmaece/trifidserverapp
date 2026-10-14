import { Schema, model } from 'mongoose';
/**
 * ENT-40 `inspection`. BR-182 — outer box only. BR-184 — **immutable once
 * submitted, the dock head signs** — there is no update route; a correction
 * would be a new document, and this milestone does not build that path
 * (nothing in scope needs it yet). BR-189 — fixed rejection reason codes.
 */
export const INSPECTION_REJECTION_REASON_CODES = [
    'case_count_short',
    'visible_external_damage',
    'leakage',
    'batch_mismatch',
    'expiry_mismatch',
];
const inspectionSchema = new Schema({
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true, unique: true },
    casesAccepted: { type: Number, required: true, min: 0 },
    casesRejected: { type: Number, required: true, min: 0 },
    reasons: [{ type: String, enum: INSPECTION_REJECTION_REASON_CODES }],
    photoRefs: [{ type: String }],
    signedBy: { type: Schema.Types.ObjectId, required: true },
    signedAt: { type: Date, required: true, default: () => new Date() },
}, { timestamps: true });
export const Inspection = model('Inspection', inspectionSchema, 'inspection');
