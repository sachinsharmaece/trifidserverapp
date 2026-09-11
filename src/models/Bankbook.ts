import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-35 `bankbook`. BR-015 — one chronological book, both directions,
 * append-only. **Controller-only reverse-and-repost** (payment.service.ts
 * `repostBankEntry`); nothing is ever deleted or edited in place. A
 * reversal points back at the entry it corrects via `reversalOf`.
 *
 * `partyId`/`partyType` identify who the money moved with — a buyer on an
 * `in` row (a posted receipt), a seller or buyer on an `out` row (a payout
 * or a refund). BR-014's ledgers are computed by summing these per party,
 * never stored as a running total on the party record itself.
 */
const bankbookSchema = new Schema(
  {
    date: { type: Date, required: true, default: () => new Date() },
    kind: { type: String, enum: ['in', 'out'], required: true },
    // Explicit, not inferred — BR-014's ledger formulas read this directly
    // rather than guessing intent from `reversalOf`/`kind` alone.
    purpose: { type: String, enum: ['receipt', 'payout', 'refund', 'reversal'], required: true },
    partyId: { type: Schema.Types.ObjectId, required: true },
    partyType: { type: String, enum: ['buyer', 'seller'], required: true },
    amountPaise: { type: Number, required: true },
    ref: { type: String, default: null },
    // No `default: null` — a sparse unique index (below) treats an explicit
    // null the same as a present value, so every entry without a UTR would
    // collide on the same indexed null. Leaving the field genuinely absent
    // is what makes `sparse` mean what it says.
    utr: { type: String },
    narration: { type: String, default: null },
    // BR-018 — NEFT/RTGS/IMPS credits carry the remitter's account and IFSC
    // on the statement line; captured here (same at-rest encryption as
    // bank_detail, shared/encryption.ts) only on `in` rows, so a refund can
    // be checked against the account the money actually came from.
    remitterAccountEncrypted: { type: String, default: null },
    remitterIfsc: { type: String, default: null },
    soIds: [{ type: Schema.Types.ObjectId, ref: 'So' }],
    queried: { type: Boolean, required: true, default: false },
    postedBy: { type: Schema.Types.ObjectId, required: true },
    reversalOf: { type: Schema.Types.ObjectId, ref: 'Bankbook', default: null },
  },
  { timestamps: true },
);

bankbookSchema.index({ utr: 1 }, { unique: true, sparse: true });
bankbookSchema.index({ partyId: 1, kind: 1 });
bankbookSchema.index({ date: 1 });

export type BankbookDocument = InferSchemaType<typeof bankbookSchema>;
export const Bankbook = model<BankbookDocument>('Bankbook', bankbookSchema, 'bankbook');
