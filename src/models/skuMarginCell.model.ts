import { Schema, model, type InferSchemaType } from 'mongoose';
import { BUYER_TIERS, SKU_MARGIN_STATUSES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * The SKU price matrix (reference LOCK-39): TriFid's margin in ₹ per unit for one pack × buyer tier, from a date,
 * overriding the Parent matrix (class × tier, in %) for that pack. A blank cell means "follow the Parent".
 * Drafted and submitted by an Admin; a DIFFERENT Admin approves (ACTIVE) or rejects it. An active cell may be
 * end-dated.
 */
const skuMarginCellSchema = new Schema(
  {
    skuId: { ...refField('Sku'), required: true },
    buyerTier: { type: String, enum: BUYER_TIERS, required: true },
    marginPaisePerUnit: { ...intField(0, 100_000_000), required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: Date,
    status: { type: String, enum: SKU_MARGIN_STATUSES, required: true, default: 'DRAFT' },
    proposedBy: { ...refField('User'), required: true },
    decidedBy: refField('User'),
    decidedAt: Date,
    rejectReason: textField(300),
  },
  { collection: 'sku_margin_cells', timestamps: true, versionKey: false },
);

skuMarginCellSchema.index({ skuId: 1, buyerTier: 1, status: 1, effectiveFrom: -1 });

export type SkuMarginCell = InferSchemaType<typeof skuMarginCellSchema>;
export const SkuMarginCellModel = model('SkuMarginCell', skuMarginCellSchema);
