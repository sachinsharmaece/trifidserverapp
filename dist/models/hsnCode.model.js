import { Schema, model } from 'mongoose';
import { HSN_PATTERN } from '../shared/validators.js';
import { bpField, refField, textField } from './_fields.js';
/** HSN tariff codes and their GST rate (SRS-MST-03). A product's tax rate defaults from here. */
const hsnCodeSchema = new Schema({
    code: {
        type: String,
        required: true,
        trim: true,
        match: [HSN_PATTERN, 'code must be 4, 6 or 8 digits'],
    },
    description: textField(300),
    /** GST rate in basis points: 1800 = 18%. */
    gstBp: { ...bpField(), required: true },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
}, { collection: 'hsn_codes', timestamps: true });
hsnCodeSchema.index({ code: 1 }, { unique: true });
export const HsnCodeModel = model('HsnCode', hsnCodeSchema);
//# sourceMappingURL=hsnCode.model.js.map