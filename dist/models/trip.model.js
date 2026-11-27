import { Schema, model } from 'mongoose';
import { BOOK_WITH_MODES, TRIP_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
/**
 * One Marg bill on a trip (SRS-LOG-06…08). Movement data only: no buyer name and no money (Logistics reads it).
 * `pod` = proof of dispatch: the LR or receipt number from the transporter (or the receiver for DIRECT), recorded
 * through the engine action `recordPod`, which moves the buyer b8 → b9.
 */
const billSchema = new Schema({
    salesOrderId: { ...refField('SalesOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    soNumber: { type: String, required: true },
    margInvoiceNumber: { ...textField(40), required: true },
    /** Where it goes: the buyer's delivery place and tehsil (never his firm name). */
    destination: { ...textField(300), required: true },
    boxes: { ...intField(1, 1_000_000), required: true },
    bookWith: {
        type: new Schema({
            mode: { type: String, enum: BOOK_WITH_MODES, required: true },
            transporter: textField(120),
        }, { _id: false }),
        required: true,
    },
    addedAt: { type: Date, required: true },
    addedBy: { ...refField('User'), required: true },
    pod: {
        type: new Schema({
            ref: { ...textField(80), required: true },
            date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
            by: { ...refField('User'), required: true },
            at: { type: Date, required: true },
        }, { _id: false }),
        default: undefined,
    },
}, { _id: false });
/**
 * A trip (T-26-0001): one vehicle leaving the Indore dock with Marg bills (SRS-LOG-07, LOCK-40 L40.11–16).
 * PLANNED (bills added or removed) → OUT (checked out: the WhatsApp notice text is stored) → CLOSED by itself
 * when every bill has a POD. A bill is on one trip only.
 *
 * Simplified: the vehicle and driver are typed on the trip (the vehicle register with owners comes later), and
 * "book with" takes the transporter's name as text (no transporter master yet).
 */
const tripSchema = new Schema({
    code: { type: String, required: true, match: /^T-\d{2}-\d{4,}$/ },
    plannedDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    vehicleNumber: { ...textField(20), required: true },
    driverName: { ...textField(100), required: true },
    driverMobile: { type: String, required: true, match: /^\d{10}$/ },
    status: { type: String, enum: TRIP_STATUSES, required: true, default: 'PLANNED' },
    bills: { type: [billSchema], default: [] },
    whatsappText: textField(4000),
    checkedOutAt: Date,
    checkedOutBy: refField('User'),
    closedAt: Date,
    createdBy: { ...refField('User'), required: true },
    version: { ...intField(0), required: true, default: 0 },
}, { collection: 'trips', timestamps: true, versionKey: false });
tripSchema.index({ code: 1 }, { unique: true });
tripSchema.index({ status: 1, plannedDate: 1 });
// A bill is on one trip only (also checked in the code: a unique index does not stop repeats inside one trip).
tripSchema.index({ 'bills.salesOrderId': 1 }, { unique: true, partialFilterExpression: { 'bills.salesOrderId': { $exists: true } } });
export const TripModel = model('Trip', tripSchema);
//# sourceMappingURL=trip.model.js.map