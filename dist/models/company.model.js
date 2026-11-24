import { Schema, model } from 'mongoose';
import { IFSC_PATTERN, isValidGstin } from '../shared/validators.js';
import { refField, textField } from './_fields.js';
/**
 * TriFid's own legal details (ARCH §B3.2). Exactly ONE document: `singleton` is fixed and unique, so a second
 * insert fails. Bank details are company money, so the account number is stored encrypted (last 4 shown).
 */
const companySchema = new Schema({
    singleton: {
        type: String,
        required: true,
        default: 'COMPANY',
        enum: ['COMPANY'],
        immutable: true,
    },
    name: { ...textField(200), required: true },
    gstin: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
        validate: {
            validator: isValidGstin,
            message: 'gstin is not a valid GSTIN (format or checksum)',
        },
    },
    /** First two digits of the GSTIN: decides intra-state (CGST+SGST) vs inter-state (IGST). Set automatically. */
    stateCode: { type: String, match: /^\d{2}$/ },
    address: { ...textField(500), required: true },
    bank: {
        accountNumberEnc: { type: String, select: false },
        accountLast4: { type: String, match: /^\d{4}$/ },
        ifsc: {
            type: String,
            trim: true,
            uppercase: true,
            match: [IFSC_PATTERN, 'ifsc is not valid'],
        },
        bankName: textField(100),
    },
    updatedBy: refField('User'),
}, { collection: 'company', timestamps: true });
companySchema.index({ singleton: 1 }, { unique: true });
companySchema.pre('validate', function () {
    if (this.gstin)
        this.stateCode = this.gstin.trim().toUpperCase().slice(0, 2);
});
export const CompanyModel = model('Company', companySchema);
//# sourceMappingURL=company.model.js.map