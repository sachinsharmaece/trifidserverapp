import { Schema, model, type InferSchemaType } from 'mongoose';
import { STOCK_PO_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore

/** One line of a Stock PO: a pack, the seller's rate per unit and the boxes. */
const lineSchema = new Schema(
  {
    lineNo: { ...intField(1, 1000), required: true },
    skuId: { ...refField('Sku'), required: true },
    productName: { ...textField(200), required: true },
    packLabel: { ...textField(60), required: true },
    unitsPerBox: { ...intField(1, 10_000), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    /** The seller's rate per unit (what TriFid pays). */
    landedPaisePerUnit: { ...intField(1, MAX_PAISE), required: true },
    /** At the dock: boxes accepted into TriFid Stock and the expiry month found. */
    acceptedBoxes: intField(0, 1_000_000),
    rejectedBoxes: intField(0, 1_000_000),
    expiryFound: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    /** The TriFid Stock listing the accepted boxes went to. */
    houseListingId: refField('Listing'),
    /** rate × units per box × boxes. */
    lineTotalPaise: { ...intField(1, MAX_PAISE), required: true },
  },
  { _id: false },
);

/**
 * A Stock PO (reference-copy branch; reference FAST-ORDER LOCK-42 L42.12): Purchase buys into TriFid Stock from an
 * outside seller, with no sales order behind it. It starts PENDING_APPROVAL; the Controller (never the person who
 * raised it) approves it and it is ISSUED. Numbered from the same PO series as trade POs.
 */
const stockPurchaseOrderSchema = new Schema(
  {
    number: { type: String, required: true, match: /^PO-\d{2}-\d{4,}$/ },
    status: { type: String, enum: STOCK_PO_STATUSES, required: true, default: 'PENDING_APPROVAL' },
    sellerId: { ...refField('Seller'), required: true },
    sellerSnapshot: {
      type: new Schema(
        {
          number: { type: String, required: true },
          firmName: { ...textField(200), required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    lines: {
      type: [lineSchema],
      required: true,
      validate: {
        validator: (lines: unknown[]) => lines.length >= 1,
        message: 'A Stock PO needs at least one line',
      },
    },
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    /** The day the seller should dispatch by. */
    dispatchDueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdBy: { ...refField('User'), required: true },
    approvedBy: refField('User'),
    approvedAt: Date,
    /** At the Indore dock (reference: a Stock PO follows the normal dock). */
    arrival: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          boxesCounted: { ...intField(0, 1_000_000), required: true },
          photoFileId: refField('UploadedFile'),
          by: { ...refField('User'), required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    checkedAt: Date,
    checkedBy: refField('User'),
  },
  { collection: 'stock_purchase_orders', timestamps: true, versionKey: false },
);

stockPurchaseOrderSchema.index({ number: 1 }, { unique: true });
stockPurchaseOrderSchema.index({ status: 1, createdAt: -1 });

export type StockPurchaseOrder = InferSchemaType<typeof stockPurchaseOrderSchema>;
export const StockPurchaseOrderModel = model('StockPurchaseOrder', stockPurchaseOrderSchema);
