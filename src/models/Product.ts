import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-12 `product`. BR-100 — a product is the brand: brand name, technical,
 * manufacturer, HSN, default class. A SKU (models/Sku.ts) is brand plus
 * pack.
 *
 * QR-018 is open: `CH §26.3` says a principal certificate "gates the
 * sellable-SKU catalogue and the data model" — i.e. it may become a field
 * here that blocks a product from being listed at all. Deliberately **no
 * placeholder field for it**: an empty field would let someone assume the
 * gate is already implemented when it is not.
 *
 * Purchase-desk v2 — `state`/`createdBy`, same draft/live workflow as
 * `models/Manufacturer.ts`. `technical` deliberately stays free text here
 * (no separate master, no draft state of its own) — the existing
 * `Product.distinct('technical', …)` picker is the whole of that axis.
 */
const productSchema = new Schema(
  {
    brand: { type: String, required: true },
    technical: { type: String, required: true },
    manufacturerId: { type: Schema.Types.ObjectId, ref: 'Manufacturer', required: true },
    hsn: { type: String, required: true },
    class: { type: String, enum: ['A', 'B', 'C'], required: true, default: 'B' },
    active: { type: Boolean, required: true, default: true },
    deletedAt: { type: Date, default: null },
    state: { type: String, enum: ['draft', 'live'], required: true, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true },
);

productSchema.index({ technical: 1 });
productSchema.index({ brand: 1, manufacturerId: 1 });

export type ProductDocument = InferSchemaType<typeof productSchema>;
export const Product = model<ProductDocument>('Product', productSchema, 'product');
