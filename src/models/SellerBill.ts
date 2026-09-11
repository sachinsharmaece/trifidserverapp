import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-32 `seller_bill`. BR-023 — bills are marked filed or unfiled; the
 * unfiled list is a standing Accounts queue. Q5a (6 Sep 2026) —
 * `acceptedValuePaise` is what the seller is actually paid on (the accepted
 * quantity only, never the bill's own `totalPaise` when there has been a
 * part rejection); `adjustmentDocRef` points at the DebitNote raised for the
 * rejected value (models/DebitNote.ts) when one exists.
 */
const sellerBillSchema = new Schema(
  {
    billNo: { type: String, required: true },
    poId: { type: Schema.Types.ObjectId, ref: 'Po', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    date: { type: Date, required: true },
    taxablePaise: { type: Number, required: true },
    taxSplit: {
      cgstPaise: { type: Number, required: true },
      sgstPaise: { type: Number, required: true },
      igstPaise: { type: Number, required: true },
    },
    totalPaise: { type: Number, required: true },
    // Q5a — defaults to totalPaise at creation; reduced to the accepted
    // value only once an inspection finds a part rejection (dock.service.ts).
    acceptedValuePaise: { type: Number, required: true },
    adjustmentDocRef: { type: Schema.Types.ObjectId, ref: 'DebitNote', default: null },
    filed: { type: Boolean, required: true, default: false },
    booked: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

sellerBillSchema.index({ poId: 1 }, { unique: true }); // BR-304 — one seller bill per seller lot.
sellerBillSchema.index({ sellerId: 1, filed: 1 });

export type SellerBillDocument = InferSchemaType<typeof sellerBillSchema>;
export const SellerBill = model<SellerBillDocument>('SellerBill', sellerBillSchema, 'seller_bill');
