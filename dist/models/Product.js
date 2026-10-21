import { Schema, model } from 'mongoose';
import { PRODUCT_CATEGORIES } from './Hsn.js';
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
 * `models/Manufacturer.ts`. `technical` stays a plain string here (the
 * counterparty pickers key on it); `models/Technical.ts` is the master it is
 * picked from. `category` and `taxPercent` (copied from `models/Hsn.ts` at
 * creation) are stored and displayed only — pricing does not read them.
 */
const productSchema = new Schema({
    brand: { type: String, required: true },
    technical: { type: String, required: true },
    manufacturerId: { type: Schema.Types.ObjectId, ref: 'Manufacturer', required: true },
    hsn: { type: String, required: true },
    // Defaults keep every pre-existing row and the Purchase-desk draft path
    // valid: all existing products are pesticides taxed at the flat 18%.
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true, default: 'pesticide' },
    taxPercent: { type: Number, required: true, min: 0, max: 100, default: 18 },
    class: { type: String, enum: ['High', 'Medium', 'Low'], required: true, default: 'Medium' },
    active: { type: Boolean, required: true, default: true },
    deletedAt: { type: Date, default: null },
    state: { type: String, enum: ['draft', 'live'], required: true, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
}, { timestamps: true });
productSchema.index({ technical: 1 });
productSchema.index({ brand: 1, manufacturerId: 1 });
export const Product = model('Product', productSchema, 'product');
