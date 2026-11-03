import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * `product_margin_matrix` — a product's own margin, in rupees, one row per tier. BR-040: "Any
 * product may carry its own override". It sits on top of `margin_matrix` (models/MarginMatrix.ts):
 * for a product and tier that has a rupee cell here, that cell prices the buyer; anything else
 * falls back to the class percentage. Resolved in pricing.service.ts, never here.
 *
 * `marginPaise` is a GST-inclusive rupee amount per base unit (LTR/KG/PC), so one number covers
 * every pack size of the product. It is never negative (BR-021). `null` is a deliberate
 * "back to the class matrix" row: BR-046 keeps rows insert-only, so a cell is cleared by a newer
 * row, never by deleting or editing an old one.
 *
 * BR-046 — same effective-dating as the class matrix: the cell that applies is the one with the
 * latest `effectiveFrom` that is not after "now".
 */
const productMarginMatrixSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    tier: { type: String, enum: ['Distributor', 'Dealer', 'Retailer', 'Trader'], required: true },
    marginPaise: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (value: number | null) => value === null || Number.isInteger(value),
        message: 'marginPaise must be a whole number of paise.',
      },
    },
    effectiveFrom: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

productMarginMatrixSchema.index({ productId: 1, tier: 1, effectiveFrom: -1 });

export type ProductMarginMatrixDocument = InferSchemaType<typeof productMarginMatrixSchema>;
export const ProductMarginMatrix = model<ProductMarginMatrixDocument>(
  'ProductMarginMatrix',
  productMarginMatrixSchema,
  'product_margin_matrix',
);
