import { Schema, model } from 'mongoose';
import { IFSC_PATTERN, isValidGstin, normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';
/**
 * Sellers (ARCH §B3.3): the firms TriFid buys from. Purchase sees them; Sales never does (visibility wall).
 * Never deleted: `active: false`. The bank account number is stored locked (AES-256-GCM) with its last 4 digits
 * and a fingerprint (`accountHash`) used to spot the same account on two sellers.
 */
const sellerSchema = new Schema({
    /** SEL-0001, filled in by `nextPartyNumber('SEL')`. */
    number: { type: String, required: true, match: /^SEL-\d{4,}$/ },
    firmName: { ...textField(200), required: true },
    /** Lower-case copy of `firmName` (filled in automatically) used for searching. */
    firmKey: { type: String, required: true },
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
    mobile: { type: String, required: true, match: [/^\d{10}$/, 'mobile must be 10 digits'] },
    contactName: textField(100),
    tehsilId: { ...refField('Tehsil'), required: true },
    address: textField(500),
    /** Time of day (HH:mm) by which the seller dispatches goods; drives the PO dispatch due date later. */
    dispatchCutoff: {
        type: String,
        required: true,
        match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'dispatchCutoff must be HH:mm'],
    },
    bank: {
        accountNumberEnc: { type: String, select: false },
        accountHash: { type: String, select: false },
        accountLast4: { type: String, required: true, match: /^\d{4}$/ },
        ifsc: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            match: [IFSC_PATTERN, 'ifsc is not valid'],
        },
        bankName: { ...textField(100), required: true },
        holderName: { ...textField(150), required: true },
    },
    /** Dealerships: the manufacturers this seller is a dealer of. */
    manufacturerIds: { type: [refField('Manufacturer')], default: [] },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
}, { collection: 'sellers', timestamps: true });
sellerSchema.index({ number: 1 }, { unique: true });
sellerSchema.index({ gstin: 1 }, { unique: true });
sellerSchema.index({ mobile: 1 }, { unique: true });
sellerSchema.index({ 'bank.accountHash': 1 }, { unique: true });
sellerSchema.index({ firmKey: 1 });
sellerSchema.index({ tehsilId: 1 });
sellerSchema.index({ manufacturerIds: 1 });
sellerSchema.pre('validate', function () {
    if (this.firmName)
        this.firmKey = normaliseKey(this.firmName);
});
export const SellerModel = model('Seller', sellerSchema);
//# sourceMappingURL=seller.model.js.map