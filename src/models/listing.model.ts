import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  AUTO_OFF_REASONS,
  EXPIRY_BANDS,
  LISTING_RATE_TYPES,
  LISTING_STATUSES,
  PROVENANCES,
} from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/** Biggest rate we accept: ₹1,00,000 per unit, in paise. Keeps every later multiplication inside safe integers. */
export const MAX_RATE_PAISE = 10_000_000;
/** Biggest carriage cost (COL) for one box, in paise: ₹1 crore. */
export const MAX_COL_PAISE = MAX_RATE_PAISE * 100;

/**
 * A seller's offer to sell one pack (SKU) at a rate. Rates are per UNIT (LOCK-38, A-2): a box's value is
 * `ratePaisePerUnit × unitsPerBox`. For an EX offer, `ratePaisePerUnit` is the landed figure
 * (`ex + round(col / unitsPerBox)`) and the raw Ex rate and COL are kept next to it. Every price uses only the landed figure.
 *
 * The visibility wall: a listing holds the seller's rate, so only Purchase and the supervisors read it (see
 * modules/listings). Sales gets buyer rates computed from it (modules/pricing), never the listing itself.
 */
const listingSchema = new Schema(
  {
    sellerId: { ...refField('Seller'), required: true },
    skuId: { ...refField('Sku'), required: true },
    rateType: { type: String, enum: LISTING_RATE_TYPES, required: true },
    ratePaisePerUnit: { ...intField(1, MAX_RATE_PAISE), required: true },
    /** Only for EX: the seller's ex-works rate per unit. */
    exRatePaisePerUnit: intField(1, MAX_RATE_PAISE),
    /** Only for EX: carriage cost for one whole box. */
    colPaisePerBox: intField(0, MAX_COL_PAISE),
    /** The pack's units per box when the listing was made, so a later pack edit does not change this listing. */
    unitsPerBoxSnapshot: { ...intField(1, 10_000), required: true },
    expiryBand: { type: String, enum: EXPIRY_BANDS, required: true },
    /** Smallest order in boxes. */
    moqBoxes: { ...intField(1, 10_000), required: true },
    /** Boxes the seller says he has. Informational only: nothing reduces it (assumption A-6). */
    quantityBoxes: { ...intField(1, 1_000_000), required: true },
    provenance: { type: String, enum: PROVENANCES, required: true },
    status: { type: String, enum: LISTING_STATUSES, required: true, default: 'ACTIVE' },
    expiresAt: { type: Date, required: true },
    /** Fingerprint of (seller, pack, rate type, rate, band, MOQ, provenance): an identical live offer is refused. */
    dedupeKey: { type: String, required: true },
    /** Present when a rate drop above the limit was confirmed by the person saving it. */
    decreaseConfirmed: {
      type: new Schema(
        {
          fromRatePaise: intField(1, MAX_RATE_PAISE),
          pctBp: intField(0, 10_000),
          by: refField('User'),
          at: Date,
        },
        { _id: false },
      ),
    },
    /** TriFid Stock only: the exact expiry month found at the dock (other listings carry only the band). */
    expiryMonth: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    /**
     * Auto-confirm (reference FAST-ORDER LOCK-42 Part A): an order up to `autoBoxesLeft` boxes is confirmed by the
     * system at "Send to seller", with no call to the seller. Always on for TriFid Stock (the house seller).
     */
    autoConfirm: { type: Boolean, required: true, default: false },
    autoBoxesSet: { ...intField(0, 1_000_000), default: 0 },
    autoBoxesLeft: { ...intField(0, 1_000_000), default: 0 },
    autoOnBy: refField('User'),
    autoOnAt: Date,
    autoOffReason: { type: String, enum: AUTO_OFF_REASONS },
    autoOffNote: textField(300),
    autoOffBy: refField('User'),
    autoOffAt: Date,
    createdBy: refField('User'),
  },
  { collection: 'listings', timestamps: true },
);

// The cheapest-first board for a pack; the "last rate" lookup when saving; the expiry sweep.
listingSchema.index({ skuId: 1, status: 1, ratePaisePerUnit: 1 });
listingSchema.index({ sellerId: 1, skuId: 1, status: 1, createdAt: -1 });
listingSchema.index({ status: 1, expiresAt: 1 });
// Two live copies of the same offer cannot exist (a withdrawn or expired one does not count).
listingSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

listingSchema.pre('validate', function () {
  if (this.rateType === 'EX') {
    if (this.exRatePaisePerUnit == null)
      this.invalidate('exRatePaisePerUnit', 'An EX offer needs the Ex rate.');
    if (this.colPaisePerBox == null)
      this.invalidate('colPaisePerBox', 'An EX offer needs the COL per box.');
  }
});

export type Listing = InferSchemaType<typeof listingSchema>;
export const ListingModel = model('Listing', listingSchema);
