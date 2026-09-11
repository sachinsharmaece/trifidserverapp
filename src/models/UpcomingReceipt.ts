import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-34 `upcoming_receipt`. BR-011/BR-012/INV-15 — a buyer's claim that he
 * has transferred money. **It is not money.** It touches no bank book and no
 * ledger until Accounts posts the matching credit (payment.service.ts
 * `postBankCredit`), which clears this row. `soIds` is picked by **Sales**,
 * not Accounts (BR-012) — "Sales knows which order he meant."
 */
const upcomingReceiptSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    amountPaise: { type: Number, required: true },
    claimedAt: { type: Date, required: true, default: () => new Date() },
    method: { type: String, enum: ['bank_message', 'utr', 'screenshot'], required: true },
    rawText: { type: String, default: null },
    utr: { type: String, default: null },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
    soIds: [{ type: Schema.Types.ObjectId, ref: 'So' }],
    pickedBy: { type: Schema.Types.ObjectId, default: null },
    state: {
      type: String,
      enum: ['waiting', 'landed_wrong_account', 'cleared'],
      required: true,
      default: 'waiting',
    },
  },
  { timestamps: true },
);

upcomingReceiptSchema.index({ buyerId: 1, state: 1 });

export type UpcomingReceiptDocument = InferSchemaType<typeof upcomingReceiptSchema>;
export const UpcomingReceipt = model<UpcomingReceiptDocument>(
  'UpcomingReceipt',
  upcomingReceiptSchema,
  'upcoming_receipt',
);
