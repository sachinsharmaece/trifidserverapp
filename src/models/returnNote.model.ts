import { Schema, model, type InferSchemaType } from 'mongoose';
import { RETURN_CLOSURES, RETURN_NOTE_TYPES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/**
 * A return note (RTN-26-0001): boxes the dock sends back to the seller (SRS-LOG-04, LOCK-40 L40.7).
 * REJECTED = damaged or leaking boxes; EXCESS = boxes beyond the PO. Due back within 30 days (RETURN_NOTE_DAYS).
 * It is OPEN until closed as picked up, shipped back or disposed of. Never deleted and never written off.
 * The return-freight debit to the seller is recorded here; posting it to his ledger comes with payouts.
 */
const returnNoteSchema = new Schema(
  {
    number: { type: String, required: true, match: /^RTN-\d{2}-\d{4,}$/ },
    purchaseOrderId: { ...refField('PurchaseOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    inspectionId: { ...refField('Inspection'), required: true },
    sellerId: { ...refField('Seller'), required: true },
    type: { type: String, enum: RETURN_NOTE_TYPES, required: true },
    /** What goes back, for the list: e.g. "Demo Insecticide · 500 ML". */
    item: { ...textField(300), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    /** e.g. "2 damaged, 1 leaking" or "3 more than ordered". */
    reason: { ...textField(200), required: true },
    dueAt: { type: Date, required: true },
    state: { type: String, enum: ['OPEN', 'CLOSED'], required: true, default: 'OPEN' },
    closure: {
      type: new Schema(
        {
          how: { type: String, enum: RETURN_CLOSURES, required: true },
          /** What sending it back cost us, if anything: to be debited to the seller. */
          freightPaise: intField(1, MAX_PAISE),
          note: textField(300),
          by: { ...refField('User'), required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    createdBy: { ...refField('User'), required: true },
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'return_notes', timestamps: true, versionKey: false },
);

returnNoteSchema.index({ number: 1 }, { unique: true });
returnNoteSchema.index({ state: 1, dueAt: 1 });
returnNoteSchema.index({ purchaseOrderId: 1 });

export type ReturnNote = InferSchemaType<typeof returnNoteSchema>;
export const ReturnNoteModel = model('ReturnNote', returnNoteSchema);
