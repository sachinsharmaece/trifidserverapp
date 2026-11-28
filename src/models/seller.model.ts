import { SELLER_TIERS } from '../shared/enums.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { IFSC_PATTERN, isValidGstin, normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';

/**
 * Sellers (ARCH §B3.3): the firms TriFid buys from. Purchase sees them; Sales never does (visibility wall).
 * Never deleted: `active: false`. The bank account number is stored locked (AES-256-GCM) with its last 4 digits
 * and a fingerprint (`accountHash`) used to spot the same account on two sellers.
 */
/** TriFid Stock (the house seller) has no GSTIN, mobile, tehsil or bank of its own: they are asked only of others. */
function notHouse(this: { isHouse?: boolean }) {
  return !this.isHouse;
}

const sellerSchema = new Schema(
  {
    /** SEL-0001, filled in by `nextPartyNumber('SEL')`. */
    number: { type: String, required: true, match: /^SEL-\d{4,}$/ },
    firmName: { ...textField(200), required: true },
    /** Lower-case copy of `firmName` (filled in automatically) used for searching. */
    firmKey: { type: String, required: true },
    gstin: {
      type: String,
      required: notHouse,
      trim: true,
      uppercase: true,
      validate: {
        validator: isValidGstin,
        message: 'gstin is not a valid GSTIN (format or checksum)',
      },
    },
    mobile: { type: String, required: notHouse, match: [/^\d{10}$/, 'mobile must be 10 digits'] },
    contactName: textField(100),
    tehsilId: { ...refField('Tehsil'), required: notHouse },
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
      accountLast4: { type: String, required: notHouse, match: /^\d{4}$/ },
      ifsc: {
        type: String,
        required: notHouse,
        trim: true,
        uppercase: true,
        match: [IFSC_PATTERN, 'ifsc is not valid'],
      },
      /** Optional on the reference-copy branch (the reference form does not ask for it). */
      bankName: textField(100),
      holderName: { ...textField(150), required: notHouse },
    },
    /** NEW → VERIFIED → TRUSTED, changed by hand by Purchase or the Controller (reference LOCK-42 L42.5). */
    tier: { type: String, enum: SELLER_TIERS, required: true, default: 'NEW' },
    /** Dealerships: the manufacturers this seller is a dealer of. */
    /** TriFid Stock: the one house seller (reference LOCK-42 L42.9). Its listings are always auto-confirm. */
    isHouse: { type: Boolean, required: true, default: false },
    manufacturerIds: { type: [refField('Manufacturer')], default: [] },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
    /** Who brought this seller in (reference acquiredByUserId): the creator. Staff hierarchy scope filters on it. */
    acquiredById: refField('User'),
  },
  { collection: 'sellers', timestamps: true },
);

sellerSchema.index({ number: 1 }, { unique: true });
sellerSchema.index(
  { gstin: 1 },
  { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } },
);
sellerSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } },
);
sellerSchema.index(
  { 'bank.accountHash': 1 },
  { unique: true, partialFilterExpression: { 'bank.accountHash': { $type: 'string' } } },
);
sellerSchema.index({ isHouse: 1 }, { unique: true, partialFilterExpression: { isHouse: true } });
sellerSchema.index({ firmKey: 1 });
sellerSchema.index({ tehsilId: 1 });
sellerSchema.index({ manufacturerIds: 1 });

sellerSchema.pre('validate', function () {
  if (this.firmName) this.firmKey = normaliseKey(this.firmName);
});

export type Seller = InferSchemaType<typeof sellerSchema>;
export const SellerModel = model('Seller', sellerSchema);
