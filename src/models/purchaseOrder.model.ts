import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  FREIGHT_TERMS,
  INSPECTION_OUTCOMES,
  LEG1_MODES,
  LISTING_RATE_TYPES,
  PURCHASE_ORDER_STATUSES,
} from '../shared/enums.js';
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

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Leg 1: how the seller sent the goods to the Indore dock (SRS §6.4 `recordLeg1`). Recorded by Purchase.
 * TRANSPORT needs the transporter and LR number; BUS the bus details and the driver's mobile; DEPOT a note.
 * `lines` = what the seller says he packed, per PO line (batch and expiry), and whether Purchase agreed to a short
 * expiry in the deal (then the dock does not even note it).
 */
const leg1Schema = new Schema(
  {
    mode: { type: String, enum: LEG1_MODES, required: true },
    transporter: textField(120),
    lrNumber: textField(60),
    lrDate: { type: String, match: DAY },
    busDetails: textField(200),
    driverName: textField(100),
    driverMobile: { type: String, match: /^\d{10}$/ },
    note: textField(300),
    freightTerms: { type: String, enum: FREIGHT_TERMS, required: true },
    /** Only when the freight is TO_PAY at Indore: it will be taken off the seller's payout. */
    freightPaise: intField(1, MAX_PAISE),
    dispatchedOn: { type: String, required: true, match: DAY },
    lines: [
      new Schema(
        {
          lineNo: { ...intField(1, 1000), required: true },
          batchDeclared: textField(60),
          expiryDeclared: { type: String, match: MONTH },
          shortExpiryAgreed: { type: Boolean, required: true, default: false },
        },
        { _id: false },
      ),
    ],
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
  },
  { _id: false },
);

/** The seller's tax invoice for this PO (needed before he is paid). Entering it again replaces it (audited). */
const sellerBillSchema = new Schema(
  {
    number: { ...textField(40), required: true },
    amountPaise: { ...intField(1, MAX_PAISE), required: true },
    billDate: { type: String, required: true, match: DAY },
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
  },
  { _id: false },
);

/** The goods reached the Indore dock (Logistics). Starts the inspection clock. */
const arrivalSchema = new Schema(
  {
    arrivedAt: { type: Date, required: true },
    boxesCounted: { ...intField(1, 1_000_000), required: true },
    /** Did the seller's bill come with the goods? */
    billWithGoods: { type: Boolean, required: true },
    at: { type: Date, required: true },
    by: { ...refField('User'), required: true },
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
    /** The seller should dispatch by then (SLA_S3_HOURS after the PO). */
    dispatchDueAt: { type: Date, required: true },
    /** Leg 1, the seller's bill and the dock's arrival (Build 3). */
    leg1: { type: leg1Schema, default: undefined },
    sellerBill: { type: sellerBillSchema, default: undefined },
    arrival: { type: arrivalSchema, default: undefined },
    /** The dock should check the goods by then (INSPECTION_HOURS after arrival). */
    inspectBy: Date,
    /** The dock check (the full record is in `inspections`): Gate B when acceptedBoxes > 0. */
    latestInspectionId: refField('Inspection'),
    outcome: { type: String, enum: INSPECTION_OUTCOMES },
    acceptedBoxes: intField(0, 1_000_000),
    /** accepted boxes × units per box × landed rate: what the seller is owed (the PURCHASE voucher). */
    acceptedValuePaise: intField(0, MAX_PAISE),
    inspectedAt: Date,
    /** The payout batch that is paying the seller (set while the batch is live, kept once paid; Build 5). */
    payoutBatchId: refField('PayoutBatch'),
    /** When the seller was paid (the UTR proof was typed). Set only by the engine's `recordSellerPayment`. */
    paidAt: Date,
    createdBy: { ...refField('User'), required: true },
    version: { ...intField(0), required: true, default: 0 },
  },
  { collection: 'purchase_orders', timestamps: true, versionKey: false },
);

purchaseOrderSchema.index({ number: 1 }, { unique: true });
purchaseOrderSchema.index({ salesOrderId: 1 }, { unique: true }); // one PO per SO (A-10)
purchaseOrderSchema.index({ sellerId: 1, createdAt: -1 });
purchaseOrderSchema.index({ status: 1, dispatchDueAt: 1 });
// The dock's lanes: Coming (DISPATCHED, oldest dispatch first), Arrived, Checked.
purchaseOrderSchema.index({ status: 1, 'leg1.at': 1 });
purchaseOrderSchema.index({ status: 1, 'arrival.arrivedAt': 1 });
purchaseOrderSchema.index({ status: 1, inspectedAt: -1 });

export type PurchaseOrder = InferSchemaType<typeof purchaseOrderSchema>;
export const PurchaseOrderModel = model('PurchaseOrder', purchaseOrderSchema);
