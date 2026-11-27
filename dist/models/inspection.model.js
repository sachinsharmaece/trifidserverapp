import { Schema, model } from 'mongoose';
import { INSPECTION_OUTCOMES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_PAISE = 100_000_000_000; // ₹100 crore
const BOXES = intField(0, 1_000_000);
/**
 * What the dock found on one PO line (LOCK-40 L40.5). "Cases" in the design = boxes (Q-LOG-06).
 *   boxesShort    worked out, never typed: PO boxes − boxes counted at arrival, taken line by line in PO order
 *   accepted      = boxes on the PO − short − damaged − leaking
 * Batch and expiry differences and a short shelf life are NOTES, never a rejection (L40.5, Q-LOG-02).
 */
const lineSchema = new Schema({
    lineNo: { ...intField(1, 1000), required: true },
    skuId: { ...refField('Sku'), required: true },
    boxesOnPo: { ...BOXES, required: true },
    boxesShort: { ...BOXES, required: true },
    boxesDamaged: { ...BOXES, required: true },
    boxesLeaking: { ...BOXES, required: true },
    boxesAccepted: { ...BOXES, required: true },
    boxesExcess: { ...BOXES, required: true },
    batchFound: textField(60),
    expiryFound: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    batchDiffers: { type: Boolean, required: true },
    expiryDiffers: { type: Boolean, required: true },
    /** Less than SHELF_LIFE_FLOOR_MONTHS left: a note for Purchase (unless short expiry was agreed). */
    belowShelfLife: { type: Boolean, required: true },
    shortExpiryAgreed: { type: Boolean, required: true },
}, { _id: false });
/**
 * One dock check of one purchase order (ARCH B3.7, `inspectLot`). Saved by any Logistics user; there is no
 * signature step (L40.4). Append-only: a saved check is never changed or deleted. A correction is a NEW check with
 * `correctsId` pointing to the one it replaces, allowed until the Marg bill is saved (Build 9, `correctInspection`).
 *
 * The outcome decides the rest (LOCK-40 A2): accepted boxes > 0 is Gate B (the PURCHASE voucher); damaged or
 * leaking boxes get a REJECTED return note; extra boxes an EXCESS return note; short, damaged and leaking boxes
 * are refunded to the buyer; nothing accepted (O4) is a seller strike and "Dock rejected" for the buyer.
 */
const inspectionSchema = new Schema({
    purchaseOrderId: { ...refField('PurchaseOrder'), required: true },
    tradeId: { ...refField('Trade'), required: true },
    /** From the arrival: how many boxes the dock counted. */
    boxesCounted: { ...intField(1, 1_000_000), required: true },
    lines: {
        type: [lineSchema],
        required: true,
        validate: {
            validator: (lines) => lines.length >= 1,
            message: 'An inspection needs at least one line',
        },
    },
    note: textField(500),
    outcome: { type: String, enum: INSPECTION_OUTCOMES, required: true },
    acceptedBoxes: { ...BOXES, required: true },
    /** Seller side: accepted boxes at the seller's landed rate. Never sent to Logistics. */
    acceptedValuePaise: { ...intField(0, MAX_PAISE), required: true },
    /** Set on a correction: the check it replaces (SRS-LOG-03). The old one is kept as it was. */
    correctsId: refField('Inspection'),
    savedBy: { ...refField('User'), required: true },
    savedAt: { type: Date, required: true },
}, { collection: 'inspections', timestamps: true, versionKey: false });
inspectionSchema.index({ purchaseOrderId: 1, savedAt: -1 });
// Append-only, like vouchers: the app may insert and read, never update or delete.
const appendOnly = () => {
    throw new Error('inspections is append-only: updates and deletes are not allowed.');
};
inspectionSchema.pre([
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
], appendOnly);
inspectionSchema.pre('save', function () {
    if (!this.isNew)
        appendOnly();
});
export const InspectionModel = model('Inspection', inspectionSchema);
//# sourceMappingURL=inspection.model.js.map