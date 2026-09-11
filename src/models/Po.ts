import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-29 `po`. Q4 (6 Sep 2026) — **no speculative stock, ever**: `chainId`
 * and `soId` are `required`, not merely present-but-nullable as
 * DATA_MODEL.md's ⚠️ pending note had them. There is no code path in this
 * codebase that creates a PO without a paid SO behind it (INV-01,
 * enforced in chain.service.ts `createPo`).
 */
export const PO_STATES = [
  'released',
  'dispatched_leg1',
  'at_indore',
  'inspected',
  'billed',
  'dispatched_leg2',
  'failed',
] as const;
export type PoState = (typeof PO_STATES)[number];

const poSchema = new Schema(
  {
    poNo: { type: String, required: true, unique: true },
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    state: { type: String, enum: PO_STATES, required: true, default: 'released' },
    dispatchDueDate: { type: Date, required: true },
    promisedOutOfIndoreBy: { type: Date, required: true },
    received: { type: Boolean, required: true, default: false },
    inspected: { type: Boolean, required: true, default: false },
    billed: { type: Boolean, required: true, default: false },
    hold: { type: Boolean, required: true, default: false },
    paid: { type: Boolean, required: true, default: false },
    failed: { type: Boolean, required: true, default: false },
    requoteCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

poSchema.index({ state: 1, dispatchDueDate: 1 });
poSchema.index({ soId: 1 }, { unique: true }); // Q4 — one PO per paid SO, never more.
poSchema.index({ sellerId: 1 });

export type PoDocument = InferSchemaType<typeof poSchema>;
export const Po = model<PoDocument>('Po', poSchema, 'po');
