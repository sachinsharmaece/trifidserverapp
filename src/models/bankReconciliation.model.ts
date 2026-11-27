import { Schema, model, type InferSchemaType } from 'mongoose';
import { BANK_RECONCILIATION_STATUSES } from '../shared/enums.js';
import { intField, refField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore
/** A bank balance may be an overdraft, so these are signed. */
const signedPaise = () => intField(-MAX_PAISE, MAX_PAISE);

/**
 * The bank reconciliation of one bank ledger on one day (SRS-PAY-05, assumption A-13): the closing balance on the
 * bank's own statement is typed in and compared with what the books say on that day. OPEN while they differ;
 * RECONCILED only when the difference is zero. Once a day is reconciled no voucher may be dated on or before it for
 * that bank ledger (modules/books/reconciliation.ts `assertBankDayOpen`).
 * Balances are signed paise: positive = money in the bank (a debit balance in the books).
 */
const bankReconciliationSchema = new Schema(
  {
    bankLedgerId: { ...refField('Ledger'), required: true },
    /** The statement date (Indian time), YYYY-MM-DD. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    statementClosingPaise: { ...signedPaise(), required: true },
    /** What the books say at the end of that day, worked out when this was saved or checked. */
    ledgerClosingPaise: { ...signedPaise(), required: true },
    /** statement − ledger. */
    differencePaise: { ...signedPaise(), required: true },
    status: {
      type: String,
      enum: BANK_RECONCILIATION_STATUSES,
      required: true,
      default: 'OPEN',
    },
    enteredBy: { ...refField('User'), required: true },
    enteredAt: { type: Date, required: true },
    reconciledBy: refField('User'),
    reconciledAt: Date,
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'bank_reconciliations', timestamps: true, versionKey: false },
);

bankReconciliationSchema.index({ bankLedgerId: 1, date: 1 }, { unique: true });
bankReconciliationSchema.index({ bankLedgerId: 1, status: 1, date: -1 });

export type BankReconciliation = InferSchemaType<typeof bankReconciliationSchema>;
export const BankReconciliationModel = model('BankReconciliation', bankReconciliationSchema);
