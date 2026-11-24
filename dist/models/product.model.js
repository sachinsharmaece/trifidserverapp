import { Schema, model } from 'mongoose';
import { PRODUCT_CATEGORIES } from '../shared/enums.js';
import { normaliseKey } from '../shared/validators.js';
import { bpField, refField, textField } from './_fields.js';
/** A product, e.g. "Confidor". It is sold in one or more packs: see `skus`. */
const productSchema = new Schema({
    name: { ...textField(200), required: true },
    /** Lower-case copy of `name`, filled in automatically, so names are unique regardless of case. */
    nameLower: { type: String, required: true },
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true, default: 'PESTICIDE' },
    manufacturerId: { ...refField('Manufacturer'), required: true },
    technicalId: { ...refField('Technical'), required: true },
    hsnCodeId: { ...refField('HsnCode'), required: true },
    /** GST rate in basis points (1800 = 18%). Starts as the HSN code's rate; Admin may change it. */
    taxBp: { ...bpField(), required: true },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
}, { collection: 'products', timestamps: true });
productSchema.index({ nameLower: 1 }, { unique: true });
productSchema.pre('validate', function () {
    this.nameLower = normaliseKey(this.name);
});
export const ProductModel = model('Product', productSchema);
//# sourceMappingURL=product.model.js.map