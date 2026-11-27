import { Schema, model, type InferSchemaType } from 'mongoose';
import { JOURNAL_KINDS, JOURNAL_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/** One line of a journal: a debit OR a credit on one ledger (the same rule as a voucher line). */
const lineSchema = new Schema(
  {
    ledgerId: { ...refField('Ledger'), required: true },
    /** The ledger's name when the journal was typed. */
    ledgerName: { ...textField(120), required: true },
    drPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
    crPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
  },
  { _id: false },
);

/**
 * A journal typed by hand (JNL-26-0001, SRS-ACC-04): any number of lines, debits equal to credits, with a narration.
 * It is saved as PENDING_APPROVAL and posts a JOURNAL voucher (JV-26-0001) only when a DIFFERENT user approves it
 * (maker ≠ checker, Founder and Admin included). Opening balances (SRS-ACC-05) are a journal of kind OPENING.
 * A posted journal is undone by a REVERSAL voucher (status REVERSED), never edited.
 * Written only by modules/books/journals.ts.
 */
const journalSchema = new Schema(
  {
    number: { type: String, required: true, match: /^JNL-\d{2}-\d{4,}$/ },
    kind: { type: String, enum: JOURNAL_KINDS, required: true, default: 'JOURNAL' },
    /** The business date, Indian time (YYYY-MM-DD). The voucher carries it. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    narration: { ...textField(300), required: true },
    lines: {
      type: [lineSchema],
      required: true,
      validate: {
        validator: (lines: { drPaise: number; crPaise: number }[]) =>
          lines.length >= 2 &&
          lines.every((line) => line.drPaise > 0 !== line.crPaise > 0) &&
          lines.reduce((sum, line) => sum + line.drPaise - line.crPaise, 0) === 0,
        message:
          'A journal needs two or more lines, each a debit or a credit, and debits = credits',
      },
    },
    /** Σ debits = Σ credits. */
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    status: { type: String, enum: JOURNAL_STATUSES, required: true, default: 'PENDING_APPROVAL' },
    createdBy: { ...refField('User'), required: true },
    /** Who approved it (never the maker) and the voucher written. */
    approvedBy: refField('User'),
    approvedAt: Date,
    voucherId: refField('Voucher'),
    rejectedBy: refField('User'),
    rejectedAt: Date,
    rejectNote: textField(300),
    cancelledAt: Date,
    /** The REVERSAL voucher that undid it, and who did it and why. */
    reversedBy: refField('User'),
    reversedAt: Date,
    reverseVoucherId: refField('Voucher'),
    reverseNote: textField(300),
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'journals', timestamps: true, versionKey: false },
);

journalSchema.index({ number: 1 }, { unique: true });
journalSchema.index({ status: 1, createdAt: -1 });

export type Journal = InferSchemaType<typeof journalSchema>;
export const JournalModel = model('Journal', journalSchema);
