import { Schema, model, type InferSchemaType } from 'mongoose';
import { proxyLogField } from '../shared/proxyLog.js';

/**
 * Purchase desk "Stock" stage — Purchase asks a seller to hold the confirmed stock for an
 * order until the buyer pays. One per sales order. It is a record of the ask and the seller's
 * answer; it never gates money. The buyer's own 24-hour payment window (BR-032) still decides
 * whether the order cancels, and the existing expiry then releases the seller with no strike.
 *
 * No PO exists yet while a hold is open — a PO is created only on a paid order (Q4, INV-01).
 */
const stockHoldSchema = new Schema(
  {
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    holdHours: { type: Number, required: true, min: 1 },
    requestedAt: { type: Date, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    holdUntil: { type: Date, required: true },
    // Set when the seller has said he is holding it; cleared if the ask is made again.
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    proxyLog: proxyLogField,
  },
  { timestamps: true },
);

stockHoldSchema.index({ soId: 1 }, { unique: true });

export type StockHoldDocument = InferSchemaType<typeof stockHoldSchema>;
export const StockHold = model<StockHoldDocument>('StockHold', stockHoldSchema, 'stock_hold');
