import { Schema, model } from 'mongoose';
import { SKU_CLASSES } from '../shared/enums.js';
import { normaliseKey } from '../shared/validators.js';
import { intField, refField, textField } from './_fields.js';
/**
 * One pack of a product, e.g. "Confidor 500 ML, 20 per box".
 * Prices are per UNIT (LOCK-38): a box's value = rate × `unitsPerBox`. `packLabel` is only a label.
 */
const skuSchema = new Schema({
    productId: { ...refField('Product'), required: true },
    /** "500 ML", "1 LTR", "10 KG": shown to people, never used in calculations. */
    packLabel: { ...textField(40), required: true },
    /** Lower-case copy of `packLabel`, filled in automatically (one "500 ML" per product). */
    packLabelLower: { type: String, required: true },
    unitsPerBox: { ...intField(1, 10_000), required: true },
    /** Pack class A/B/C: with the buyer tier, picks the margin. */
    skuClass: { type: String, enum: SKU_CLASSES, required: true },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
}, { collection: 'skus', timestamps: true });
skuSchema.index({ productId: 1, packLabelLower: 1 }, { unique: true });
skuSchema.pre('validate', function () {
    this.packLabelLower = normaliseKey(this.packLabel);
});
export const SkuModel = model('Sku', skuSchema);
//# sourceMappingURL=sku.model.js.map