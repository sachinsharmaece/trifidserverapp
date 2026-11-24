import { Schema, model } from 'mongoose';
import { SETTING_TYPES } from '../shared/enums.js';
import { refField } from './_fields.js';
/**
 * Tunable business values (SLA hours, windows, tolerances, feature switches) kept as data, not code
 * (SRS principle 7). Defaults are seeded by `npm run db:seed`; Admin edits them later (with step-up).
 */
const settingSchema = new Schema({
    key: { type: String, required: true, trim: true, match: /^[A-Z][A-Z0-9_]*$/, maxlength: 60 },
    value: { type: Schema.Types.Mixed, required: true },
    type: { type: String, enum: SETTING_TYPES, required: true },
    description: { type: String, maxlength: 300 },
    updatedBy: refField('User'),
}, { collection: 'settings', timestamps: true });
settingSchema.index({ key: 1 }, { unique: true });
// The stored value must match its declared type.
settingSchema.path('value').validate(function (value) {
    switch (this.type) {
        case 'NUMBER':
            return typeof value === 'number' && Number.isFinite(value);
        case 'STRING':
            return typeof value === 'string';
        case 'BOOLEAN':
            return typeof value === 'boolean';
        case 'JSON':
            return value !== null && typeof value === 'object';
        default:
            return false;
    }
}, 'value does not match the setting type');
export const SettingModel = model('Setting', settingSchema);
//# sourceMappingURL=setting.model.js.map