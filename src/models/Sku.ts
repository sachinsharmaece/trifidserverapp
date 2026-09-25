import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-13 `sku`. BR-100 — brand plus pack. BR-055 —`baseUnit` is **immutable
 * at the schema level**: `immutable: true` makes Mongoose refuse the field
 * on every save after creation, so there is no code path that can change it,
 * not even a bug. `baseUnitsPerBox` is **derived**, never accepted from a
 * client — the `pre('validate')` hook below is the only place that computes
 * it, from `baseUnit`, `packSize` and `unitsPerBox`.
 *
 * Purchase-desk v2 — `state`/`createdBy`, same draft/live workflow as
 * `models/Manufacturer.ts`/`models/Product.ts`.
 */
const skuSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    packLabel: { type: String, required: true },
    packSize: { type: Number, required: true },
    baseUnit: { type: String, enum: ['LTR', 'KG', 'PC'], required: true, immutable: true },
    unitsPerBox: { type: Number, required: true },
    baseUnitsPerBox: { type: Number, required: true },
    class: { type: String, enum: ['A', 'B', 'C'] },
    active: { type: Boolean, required: true, default: true },
    deletedAt: { type: Date, default: null },
    state: { type: String, enum: ['draft', 'live'], required: true, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true },
);

skuSchema.index({ productId: 1, packLabel: 1 }, { unique: true });

// BR-055 — LTR/KG: baseUnitsPerBox = packSize × unitsPerBox. PC: pack size is
// descriptive only, so baseUnitsPerBox = unitsPerBox.
skuSchema.pre('validate', function computeBaseUnitsPerBox() {
  this.baseUnitsPerBox =
    this.baseUnit === 'PC' ? this.unitsPerBox : this.packSize * this.unitsPerBox;
});

export type SkuDocument = InferSchemaType<typeof skuSchema>;
export const Sku = model<SkuDocument>('Sku', skuSchema, 'sku');
