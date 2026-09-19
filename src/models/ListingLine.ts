import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-18 `listing_line`. BR-101 — the condition set is four fields:
 * expiry band · MOQ band · delivery band · provenance. Two lines collapse
 * into one comparison only where all four match, on the same SKU.
 *
 * `deliveryBand` — answered `QR-012` (M4 session, `BR-104`): two values,
 * not four, and independent of provenance (D-04 — any band on any provenance;
 * the earlier "tied to provenance" wording was a misreading). `QR-034` (this session) relabels the same
 * stored value as end-to-end on the buyer surface without changing what is
 * stored or how the pool match key works — see `QR-043`.
 *
 * `moqBand` values are the prototype's own fixture (`supplier.html`), which
 * the Charter (`BR-150`) does not itself enumerate beyond "any MOQ above 1
 * opens a pool" — followed here as the layout/behaviour spec this session
 * was told to use.
 */
export const EXPIRY_BANDS = ['over12', 'under12'] as const;
export const MOQ_BANDS = ['1', 'up25', '26-100', '101-250', '250+'] as const;
export const DELIVERY_BANDS = ['48h', '2-5d'] as const;
export const PROVENANCE_VALUES = ['company', 'auth'] as const;

export type ExpiryBand = (typeof EXPIRY_BANDS)[number];
export type MoqBand = (typeof MOQ_BANDS)[number];
export type DeliveryBand = (typeof DELIVERY_BANDS)[number];
export type Provenance = (typeof PROVENANCE_VALUES)[number];

/**
 * BR-150 — MOQ is a specific number the seller sets (default 1; any value
 * above 1 opens a pool). `moqBand` is the matching-key bucket **derived**
 * from that number, the same relationship `Sku.baseUnitsPerBox` has to
 * `unitsPerBox` — never accepted from a client, computed here once.
 */
export function deriveMoqBand(moqExact: number): MoqBand {
  if (moqExact <= 1) return '1';
  if (moqExact <= 25) return 'up25';
  if (moqExact <= 100) return '26-100';
  if (moqExact <= 250) return '101-250';
  return '250+';
}

const listingLineSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', required: true },
    ratePaise: { type: Number, required: true },
    expiryBand: { type: String, enum: EXPIRY_BANDS, required: true },
    expiryExact: { type: String, default: null }, // MM/YYYY — an expectation, not a promise (BR-102).
    expiryFixed: { type: Boolean, required: true, default: false },
    moqExact: { type: Number, required: true, min: 1, default: 1 }, // BR-150 — the seller sets this; default 1.
    moqBand: { type: String, enum: MOQ_BANDS, required: true }, // Derived below — never accepted from a client.
    deliveryBand: { type: String, enum: DELIVERY_BANDS, required: true },
    provenance: { type: String, enum: PROVENANCE_VALUES, required: true },
    batch: { type: String, default: null }, // Mandatory only on `auth` (BR-105) — checked in validation.
    qty: { type: Number, required: true, min: 0 },
    version: { type: Number, required: true, default: 0 }, // Optimistic lock — not a reservation (BR-134).
  },
  { timestamps: true },
);

listingLineSchema.pre('validate', function computeMoqBand() {
  this.moqBand = deriveMoqBand(this.moqExact);
});

listingLineSchema.index({ listingId: 1, skuId: 1 }, { unique: true });
listingLineSchema.index({ skuId: 1, moqBand: 1, expiryBand: 1, deliveryBand: 1, provenance: 1 });

export type ListingLineDocument = InferSchemaType<typeof listingLineSchema>;
export const ListingLine = model<ListingLineDocument>(
  'ListingLine',
  listingLineSchema,
  'listing_line',
);
