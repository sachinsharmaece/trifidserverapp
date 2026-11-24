import { Schema, model } from 'mongoose';
import { normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';
/** Active ingredients ("technicals"), e.g. "Imidacloprid". Never deleted: set `active: false` instead. */
const technicalSchema = new Schema({
    name: { ...textField(150), required: true },
    /** Lower-case copy of `name`, filled in automatically, so names are unique regardless of case. */
    nameLower: { type: String, required: true },
    /** Optional composition detail, e.g. "Azadirachtin 0.03% EC". */
    description: textField(300),
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
}, { collection: 'technicals', timestamps: true });
technicalSchema.index({ nameLower: 1 }, { unique: true });
technicalSchema.pre('validate', function () {
    this.nameLower = normaliseKey(this.name);
});
export const TechnicalModel = model('Technical', technicalSchema);
//# sourceMappingURL=technical.model.js.map