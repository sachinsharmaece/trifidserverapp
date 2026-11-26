import { Schema, model, type InferSchemaType } from 'mongoose';
import { LEDGER_GROUPS } from '../shared/enums.js';

/**
 * The 12 fixed ledger groups (SRS-ACC-02): Sundry Debtors, Sundry Creditors, Bank Accounts, Sales, … They only
 * sort ledgers for reports. Created by `npm run db:seed`, or the first time the books need one (books.ts).
 */
const ledgerGroupSchema = new Schema(
  {
    name: { type: String, enum: LEDGER_GROUPS, required: true },
  },
  { collection: 'ledger_groups', timestamps: true, versionKey: false },
);

ledgerGroupSchema.index({ name: 1 }, { unique: true });

export type LedgerGroup = InferSchemaType<typeof ledgerGroupSchema>;
export const LedgerGroupModel = model('LedgerGroup', ledgerGroupSchema);
