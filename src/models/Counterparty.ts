import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-01 `counterparty`. The firm. One GSTIN is one firm is one account
 * (`BR-240`). A firm may be both a buyer and a seller (`BR-092`).
 *
 * `licenceExpiry` is deliberately **not** on this schema — `DATA_MODEL.md`
 * ENT-01 marks it pending `QR-019`, and M3's interim position is to capture
 * only what is already confirmed (licence *number*, not an expiry date).
 */
const counterpartySchema = new Schema(
  {
    gstin: { type: String, unique: true, sparse: true },
    firm: { type: String },
    ownerName: { type: String },
    mobile: { type: String, required: true, unique: true },
    licenceNo: { type: String },
    kind: { type: String, enum: ['buyer', 'seller', 'both'], required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'blacklisted'],
      required: true,
      default: 'pending',
    },
    termsVersion: { type: String },
    termsAcceptedAt: { type: Date },
    // Referral code only, immutable, decays at 45 days (BR-330) — decay is
    // read-time (compare acquiredAt against now), not a background job.
    acquiredBy: { type: String, default: null },
    acquiredAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

counterpartySchema.index({ status: 1 });
counterpartySchema.index({ kind: 1, status: 1 });

export type CounterpartyDocument = InferSchemaType<typeof counterpartySchema>;
export const Counterparty = model<CounterpartyDocument>(
  'Counterparty',
  counterpartySchema,
  'counterparty',
);
