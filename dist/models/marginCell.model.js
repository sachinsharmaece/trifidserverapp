import { Schema, model } from 'mongoose';
import { BUYER_TIERS, SKU_CLASSES } from '../shared/enums.js';
import { bpField, refField } from './_fields.js';
/**
 * TriFid's margin for a pack class × buyer tier, from a date onwards (the "Parent matrix", ARCH §B3.2).
 * Cells are never edited: a new rate is a new cell with a later `effectiveFrom`. Pricing uses the latest
 * cell whose `effectiveFrom` ≤ the pricing time; with no cell the board shows "Rate unavailable" (SRS-MST-05).
 */
const marginCellSchema = new Schema({
    skuClass: { type: String, enum: SKU_CLASSES, required: true, immutable: true },
    buyerTier: { type: String, enum: BUYER_TIERS, required: true, immutable: true },
    /** 2000 = 20%. */
    marginBp: { ...bpField(), required: true, immutable: true },
    effectiveFrom: { type: Date, required: true, immutable: true },
    /** Who set it (a step-up action). */
    createdBy: { ...refField('User'), required: true, immutable: true },
}, { collection: 'margin_cells', timestamps: true, versionKey: false });
// Also serves the lookup: { skuClass, buyerTier, effectiveFrom: { $lte: t } } sorted by effectiveFrom desc.
marginCellSchema.index({ skuClass: 1, buyerTier: 1, effectiveFrom: 1 }, { unique: true });
export const MarginCellModel = model('MarginCell', marginCellSchema);
//# sourceMappingURL=marginCell.model.js.map