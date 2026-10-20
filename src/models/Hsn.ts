import { Schema, model, type InferSchemaType } from 'mongoose';

export const PRODUCT_CATEGORIES = ['seed', 'pesticide', 'fertilizer'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/**
 * HSN master. Holds the default GST rate for a code; a product copies that rate
 * onto itself when it is created (`Product.taxPercent`), so later changing a
 * master rate never silently re-prices existing products. Deliberately not tied
 * to a product category — an HSN is valid for whichever category uses it.
 *
 * The rate is stored and shown only: pricing still uses the single
 * `GST_RATE_PERCENT` in `shared/pricing.ts` and is not driven from here.
 */
const hsnSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    taxPercent: { type: Number, required: true, min: 0, max: 100 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export type HsnDocument = InferSchemaType<typeof hsnSchema>;
export const Hsn = model<HsnDocument>('Hsn', hsnSchema, 'hsn');
