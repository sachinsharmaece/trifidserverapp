import { Schema, model, type InferSchemaType } from 'mongoose';
import { BUYER_TIERS, TRADE_POSITIONS } from '../shared/enums.js';
import { isValidGstin, normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';

/**
 * Buyers (ARCH §B3.3): the firms TriFid sells to. Sales sees them; Purchase never does (visibility wall).
 * Never deleted: `active: false`. A buyer with no GSTIN is a B2C buyer.
 */
const buyerSchema = new Schema(
  {
    /** BUY-0001, filled in by `nextPartyNumber('BUY')`. */
    number: { type: String, required: true, match: /^BUY-\d{4,}$/ },
    firmName: { ...textField(200), required: true },
    /** Lower-case copy of `firmName` (filled in automatically) used for searching. */
    firmKey: { type: String, required: true },
    contactName: { ...textField(100), required: true },
    /** 10-digit mobile numbers, the main one first. Each number belongs to one buyer only. */
    mobiles: {
      type: [{ type: String, match: [/^\d{10}$/, 'a mobile number must be 10 digits'] }],
      validate: {
        validator: (list: string[]) => list.length >= 1 && list.length <= 5,
        message: 'a buyer needs 1 to 5 mobile numbers',
      },
    },
    /** Optional. When it is given it must be valid and not used by another buyer. */
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      validate: {
        validator: isValidGstin,
        message: 'gstin is not a valid GSTIN (format or checksum)',
      },
    },
    tehsilId: { ...refField('Tehsil'), required: true },
    village: textField(100),
    address: { ...textField(500), required: true },
    deliveryLocation: { ...textField(200), required: true },
    /** GST state code: from the GSTIN, or from the tehsil's state when there is no GSTIN. Set by the API. */
    stateCode: { type: String, required: true, match: /^\d{2}$/ },
    tradePosition: { type: String, required: true, enum: TRADE_POSITIONS },
    traderFlag: { type: Boolean, required: true, default: false },
    /** Worked out from the two fields above (trader flag wins), filled in automatically. */
    rateTier: { type: String, required: true, enum: BUYER_TIERS },
    /** Empty until the buyer is classified: until then rates are shown as "indicative" (priced as RETAILER). */
    classifiedAt: Date,
    /** Dealerships: the manufacturers this buyer is a dealer of. */
    manufacturerIds: { type: [refField('Manufacturer')], default: [] },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
    /**
     * Who holds this buyer now (reference acquiredByUserId). The creator, or with the dormant policy on, the holder
     * the dormancy module chose; empty while the buyer is in the Pool. Staff hierarchy scope filters on it.
     */
    acquiredById: refField('User'),
  },
  { collection: 'buyers', timestamps: true },
);

buyerSchema.index({ number: 1 }, { unique: true });
buyerSchema.index({ mobiles: 1 }, { unique: true }); // multikey: no mobile number on two buyers
buyerSchema.index(
  { gstin: 1 },
  { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } },
);
buyerSchema.index({ firmKey: 1 });
buyerSchema.index({ tehsilId: 1 });
buyerSchema.index({ manufacturerIds: 1 });

buyerSchema.pre('validate', function () {
  if (this.firmName) this.firmKey = normaliseKey(this.firmName);
  if (this.tradePosition) this.rateTier = this.traderFlag ? 'TRADER' : this.tradePosition;
});

export type Buyer = InferSchemaType<typeof buyerSchema>;
export const BuyerModel = model('Buyer', buyerSchema);
