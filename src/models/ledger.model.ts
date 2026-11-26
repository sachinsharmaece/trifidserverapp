import { Schema, model, type InferSchemaType } from 'mongoose';
import { BANK_KINDS } from '../shared/enums.js';
import { IFSC_PATTERN } from '../shared/validators.js';
import { intField, refField, textField } from './_fields.js';

/**
 * A ledger: one account's running record in the books (SRS-ACC-02, ARCH B3.5). One per buyer (under Sundry
 * Debtors), one per seller (Sundry Creditors) and one per bank account of ours (Bank Accounts). A firm that both
 * buys and sells gets two ledgers. A ledger's balance is the sum of its voucher lines; it is never stored here.
 *
 * Bank ledgers ARE the bank master (one bank master, SRS-ACC-02): the account number is encrypted, and only its
 * last 4 digits are ever sent to a screen. Buyer and seller ledgers are made the first time money moves for them
 * (modules/books/books.ts).
 */
const ledgerSchema = new Schema(
  {
    name: { ...textField(120), required: true },
    /** Lower-case name, for the "no two ledgers with the same name" rule. */
    nameKey: { type: String, required: true },
    groupId: { ...refField('LedgerGroup'), required: true },
    /** Set on buyer and seller ledgers only. */
    party: {
      type: new Schema(
        {
          side: { type: String, enum: ['BUYER', 'SELLER'], required: true },
          buyerId: refField('Buyer'),
          sellerId: refField('Seller'),
        },
        { _id: false },
      ),
      default: undefined,
    },
    gstin: { type: String, match: /^[0-9A-Z]{15}$/ },
    stateCode: { type: String, match: /^\d{2}$/ },
    /** Set on bank ledgers only. */
    bank: {
      type: new Schema(
        {
          kind: { type: String, enum: BANK_KINDS, required: true },
          bankName: { ...textField(100), required: true },
          accountNumberEnc: { type: String, select: false },
          accountLast4: { type: String, required: true, match: /^\d{4}$/ },
          ifsc: {
            type: String,
            trim: true,
            uppercase: true,
            match: [IFSC_PATTERN, 'ifsc is not valid'],
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    active: { type: Boolean, required: true, default: true },
    createdBy: { ...refField('User'), required: true },
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'ledgers', timestamps: true, versionKey: false },
);

ledgerSchema.index({ nameKey: 1 }, { unique: true });
ledgerSchema.index({ groupId: 1, name: 1 });
// One ledger per buyer and per seller.
ledgerSchema.index(
  { 'party.buyerId': 1 },
  { unique: true, partialFilterExpression: { 'party.side': 'BUYER' } },
);
ledgerSchema.index(
  { 'party.sellerId': 1 },
  { unique: true, partialFilterExpression: { 'party.side': 'SELLER' } },
);

export type Ledger = InferSchemaType<typeof ledgerSchema>;
export const LedgerModel = model('Ledger', ledgerSchema);
