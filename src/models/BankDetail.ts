import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-09 `bank_detail`. BR-017 — a change does not become payable-to until
 * 24 hours after a verified call-back **to the number already on file**.
 * `accountEncrypted` is written only through `shared/encryption.ts` — never
 * a plain account number, and masked in every response
 * (`onboarding.dto.ts`).
 */
const bankDetailSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    accountEncrypted: { type: String, required: true },
    ifsc: { type: String, required: true },
    accountName: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, default: null },
    callbackLoggedAt: { type: Date, default: null },
    effectiveFrom: { type: Date, default: null },
    isActive: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

bankDetailSchema.index({ counterpartyId: 1, isActive: 1 });

export type BankDetailDocument = InferSchemaType<typeof bankDetailSchema>;
export const BankDetail = model<BankDetailDocument>('BankDetail', bankDetailSchema, 'bank_detail');
