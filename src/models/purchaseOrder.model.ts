import { Schema, model, type InferSchemaType } from 'mongoose';
import { LISTING_RATE_TYPES, PURCHASE_ORDER_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/** One line of a purchase order, copied from the seller's answer when the buyer has paid in full. */
const lineSchema = new Schema(
  {
    lineNo: { ...intField(1, 1000), required: true },
    skuId: { ...refField('Sku'), required: true },
    productName: { ...textField(200), required: true },
    packLabel: { ...textField(60), required: true },
    unitsPerBox: { ...intField(1, 10_000), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    expiryMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    batchNumber: textField(60),
    /** What one unit costs us delivered to Indore (the seller's landed rate, FOR or Ex + carriage). */
    landedPaisePerUnit: { ...intField(1, MAX_PAISE), required: true },
    /** From the listing, when there was one: FOR, or EX with the ex-works rate and carriage per box. */
    rateType: { type: String, enum: LISTING_RATE_TYPES },
    exRatePaisePerUnit: intField(1, MAX_PAISE),
    colPaisePerBox: intField(0, MAX_PAISE),
    /** landed × units per box × boxes. */
    lineTotalPaise: { ...intField(1, MAX_PAISE), required: true },
  },
  { _id: false },
);

/**
 * A purchase order (PO-26-0001): what we buy from the seller for one paid sales order (ARCH B3.4, A-10: one PO
 * per SO, one seller per SO). Raised ONLY by the trade engine at Gate A, when Accounts confirms that the buyer
 * has paid the order in full (Q-ACC-01). Never deleted.
 *
 * The seller side of the wall: a PO names the seller and his rate and NEVER the buyer or our selling rate, so
 * Purchase can read it. Sales never reads POs.
 */
const purchaseOrderSchema = new Schema(
  {
    number: { type: String, required: true, match: /^PO-\d{2}-\d{4,}$/ },
    salesOrderId: { ...refField('SalesOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    sellerId: { ...refField('Seller'), required: true },
    /** The seller as he was when the PO was raised. */
    sellerSnapshot: {
      type: new Schema(
        {
          number: { type: String, required: true },
          firmName: { ...textField(200), required: true },
          gstin: { type: String, match: /^[0-9A-Z]{15}$/ },
        },
        { _id: false },
      ),
      required: true,
    },
    status: { type: String, enum: PURCHASE_ORDER_STATUSES, required: true, default: 'RAISED' },
    lines: {
      type: [lineSchema],
      required: true,
      validate: {
        validator: (lines: unknown[]) => lines.length >= 1,
        message: 'A purchase order needs at least one line',
      },
    },
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    /** The seller should dispatch by then (SLA_S3_HOURS after the PO). Dispatch itself is the next step. */
    dispatchDueAt: { type: Date, required: true },
    createdBy: { ...refField('User'), required: true },
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'purchase_orders', timestamps: true, versionKey: false },
);

purchaseOrderSchema.index({ number: 1 }, { unique: true });
purchaseOrderSchema.index({ salesOrderId: 1 }, { unique: true }); // one PO per SO (A-10)
purchaseOrderSchema.index({ sellerId: 1, createdAt: -1 });
purchaseOrderSchema.index({ status: 1, dispatchDueAt: 1 });

export type PurchaseOrder = InferSchemaType<typeof purchaseOrderSchema>;
export const PurchaseOrderModel = model('PurchaseOrder', purchaseOrderSchema);
