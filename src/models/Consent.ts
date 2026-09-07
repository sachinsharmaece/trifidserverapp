import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-52 `consent`. Not in MASTER_PLAN.md §M3's listed `ENT-01`–`ENT-16`
 * range, but required by this milestone's own instructions and `BR-340`:
 * registration persists three consent records (terms, transactional
 * notice, marketing — separate opt-in) with version and timestamp.
 */
const consentSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    type: { type: String, enum: ['terms', 'transactional', 'marketing'], required: true },
    noticeVersion: { type: String, required: true },
    givenAt: { type: Date, required: true },
    withdrawnAt: { type: Date, default: null },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true },
);

consentSchema.index({ counterpartyId: 1, type: 1 });

export type ConsentDocument = InferSchemaType<typeof consentSchema>;
export const Consent = model<ConsentDocument>('Consent', consentSchema, 'consent');
