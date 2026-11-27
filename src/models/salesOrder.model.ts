import { Schema, model, type InferSchemaType } from 'mongoose';
import { BUYER_TIERS, SALES_ORDER_STATUSES, SKU_CLASSES } from '../shared/enums.js';
import { bpField, intField, refField, textField } from './_fields.js';

const MAX_PAISE = 100_000_000_000; // ₹100 crore: far above any real order, only stops typing mistakes

/** One line of a sales order. Everything is copied ("frozen") when the buyer says yes, so it never changes later. */
const lineSchema = new Schema(
  {
    lineNo: { ...intField(1, 1000), required: true },
    tradeId: { ...refField('Trade'), required: true },
    listingId: refField('Listing'),
    skuId: { ...refField('Sku'), required: true },
    productName: { ...textField(200), required: true },
    packLabel: { ...textField(60), required: true },
    unitsPerBox: { ...intField(1, 10_000), required: true },
    hsnCode: { ...textField(20), required: true },
    skuClass: { type: String, enum: SKU_CLASSES, required: true },
    rateTier: { type: String, enum: BUYER_TIERS, required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    expiryMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    batchNumber: textField(60),
    /** The seller's rate per unit (seller side of the wall: never sent to Sales or Accounts). */
    landedPaisePerUnit: { ...intField(1, MAX_PAISE), required: true },
    /** Our rate to the buyer per unit, tax included (the offer fixed when the seller answered). */
    buyerRatePaisePerUnit: { ...intField(1, MAX_PAISE), required: true },
    boxValuePaise: { ...intField(1, MAX_PAISE), required: true },
    lineTotalPaise: { ...intField(1, MAX_PAISE), required: true },
    taxBp: { ...bpField(), required: true },
  },
  { _id: false },
);

/**
 * The Marg invoice for this order (FR-ACC-04, LOCK-40 L40.9), keyed by Accounts after the dock check. Buyer side
 * of the wall (it is our selling price), so it lives on the sales order, not the PO. `expectedPaise` = accepted
 * boxes × units per box × the buyer's rate; the bill may not be higher (Q-ACC-02: a lower bill is allowed and
 * the difference is kept).
 */
const margBillSchema = new Schema(
  {
    invoiceNumber: { ...textField(40), required: true },
    ewayBillNumber: textField(40),
    /** The Marg bill PDF (an UploadedFile), kept by the reference To-be-billed screen. */
    pdfFileId: refField('UploadedFile'),
    billDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    expectedPaise: { ...intField(1, MAX_PAISE), required: true },
    /** Boxes billed per order line (never more than were accepted at the dock). */
    lines: [
      new Schema(
        {
          lineNo: { ...intField(1, 1000), required: true },
          boxes: { ...intField(1, 1_000_000), required: true },
        },
        { _id: false },
      ),
    ],
    voucherId: { ...refField('Voucher'), required: true },
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
  },
  { _id: false },
);

/**
 * A sales order (SO-26-0001): what the buyer agreed to buy and must pay for (ARCH B3.4 `sales_orders`, simplified).
 * Raised ONLY by the trade engine when the buyer says yes (`buyerYes`, SRS-TRD-09), and cancelled only by the
 * engine when he drops it (`leakAfterOrder`). Never deleted.
 *
 * The record holds the seller and his rate, so it is never sent as it is: `modules/salesOrders/salesOrders.ts`
 * builds the view for each role.
 */
const salesOrderSchema = new Schema(
  {
    number: { type: String, required: true, match: /^SO-\d{2}-\d{4,}$/ },
    buyerId: { ...refField('Buyer'), required: true },
    /** The buyer as he was when he said yes. */
    buyerSnapshot: {
      type: new Schema(
        {
          number: { type: String, required: true },
          firmName: { ...textField(200), required: true },
          gstin: textField(15),
          stateCode: { type: String, required: true, match: /^\d{2}$/ },
          deliveryLocation: { ...textField(200), required: true },
          rateTier: { type: String, enum: BUYER_TIERS, required: true },
          classified: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    tradeId: { ...refField('Trade'), required: true },
    /** One seller per order (ARCH A-10). Seller side of the wall. */
    sellerId: { ...refField('Seller'), required: true },
    status: {
      type: String,
      enum: SALES_ORDER_STATUSES,
      required: true,
      default: 'AWAITING_PAYMENT',
    },
    /** True when the buyer's state is not ours: IGST instead of CGST + SGST. */
    interState: { type: Boolean, required: true },
    lines: {
      type: [lineSchema],
      required: true,
      validate: {
        validator: (lines: unknown[]) => lines.length >= 1,
        message: 'An order needs at least one line',
      },
    },
    /** Σ line totals, tax included. */
    totalPaise: { ...intField(1, MAX_PAISE), required: true },
    /** The tax inside the total (`splitGst` in shared/money.ts). */
    gst: {
      type: new Schema(
        {
          taxablePaise: { ...intField(0, MAX_PAISE), required: true },
          cgstPaise: { ...intField(0, MAX_PAISE), required: true },
          sgstPaise: { ...intField(0, MAX_PAISE), required: true },
          igstPaise: { ...intField(0, MAX_PAISE), required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    /** The buyer must pay by then (PAYMENT_WINDOW_HOURS after he said yes). */
    paymentDueAt: { type: Date, required: true },
    /** Money confirmed by Accounts against this order (Σ posted receipts). PAID once it reaches the total. */
    paidPaise: { ...intField(0, MAX_PAISE), required: true, default: 0 },
    paidAt: Date,
    /** Build 4: the Marg bill (BILLED), the proof of dispatch on a trip (DISPATCHED), then delivery. */
    margBill: { type: margBillSchema, default: undefined },
    /** Reference-copy branch: did the buyer take transit insurance? Declining needs a reason. */
    insurance: {
      type: new Schema(
        { elected: { type: Boolean, required: true }, declineReason: textField(300) },
        { _id: false },
      ),
      default: undefined,
    },
    dispatchedAt: Date,
    deliveredAt: Date,
    /** Set when the buyer drops the order before paying. */
    cancel: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          byUserId: { ...refField('User'), required: true },
          reasonCodeId: { ...refField('ReasonCode'), required: true },
          reasonLabel: { ...textField(120), required: true },
          note: textField(300),
        },
        { _id: false },
      ),
      default: undefined,
    },
    createdBy: { ...refField('User'), required: true },
    /** Goes up by 1 on every change (cancel now, payments later), like a trade's version. */
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'sales_orders', timestamps: true, versionKey: false },
);

salesOrderSchema.index({ number: 1 }, { unique: true });
salesOrderSchema.index({ buyerId: 1, createdAt: -1 });
salesOrderSchema.index({ status: 1, paymentDueAt: 1 });
salesOrderSchema.index({ tradeId: 1 });
// A Marg invoice number is used once.
salesOrderSchema.index(
  { 'margBill.invoiceNumber': 1 },
  { unique: true, partialFilterExpression: { 'margBill.invoiceNumber': { $exists: true } } },
);
salesOrderSchema.index({ status: 1, 'margBill.at': -1 });

export type SalesOrder = InferSchemaType<typeof salesOrderSchema>;
export const SalesOrderModel = model('SalesOrder', salesOrderSchema);
