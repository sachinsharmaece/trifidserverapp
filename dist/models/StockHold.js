import { Schema, model } from 'mongoose';
import { proxyLogField } from '../shared/proxyLog.js';
/**
 * Purchase desk "Stock" stage — the seller holds the confirmed stock for an order until the
 * buyer pays. Opened automatically with the order (see `createSoInSession`); Purchase can only
 * adjust the hours. One per sales order. It is a record of the ask and the seller's
 * answer; it never gates money. The buyer's own 24-hour payment window (BR-032) still decides
 * whether the order cancels, and the existing expiry then releases the seller with no strike.
 *
 * No PO exists yet while a hold is open — a PO is created only on a paid order (Q4, INV-01).
 */
const stockHoldSchema = new Schema({
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    holdHours: { type: Number, required: true, min: 1 },
    requestedAt: { type: Date, required: true },
    // Null for an `auto` hold — the system started it, no member of staff did.
    requestedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    // `auto`: opened with the order itself (the seller already agreed to supply when he quoted
    // or confirmed); `staff`: Purchase asked for it by hand.
    source: { type: String, enum: ['auto', 'staff'], default: 'staff' },
    holdUntil: { type: Date, required: true },
    // Set when the seller is holding it — at once for an `auto` hold; cleared if a staff ask is made again.
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    proxyLog: proxyLogField,
}, { timestamps: true });
stockHoldSchema.index({ soId: 1 }, { unique: true });
export const StockHold = model('StockHold', stockHoldSchema, 'stock_hold');
