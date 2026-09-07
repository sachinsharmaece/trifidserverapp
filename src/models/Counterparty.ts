import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-01 `counterparty` — minimal shape for M1/M2 only.
 *
 * DATA_MODEL.md ENT-01 defines the full future shape (firm, ownerName,
 * licenceNo, terms acceptance, etc.) — that is M3 registration work. This
 * session needs only enough to authenticate a counterparty and place it
 * behind the pending/active/rejected gate (ST-10).
 */
const counterpartySchema = new Schema(
  {
    mobile: { type: String, required: true, unique: true },
    gstin: { type: String, unique: true, sparse: true },
    kind: { type: String, enum: ['buyer', 'seller', 'both'], required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'blacklisted'],
      required: true,
      default: 'pending',
    },
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
