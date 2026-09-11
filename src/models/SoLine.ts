import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-28 `so_line`. BR-045 — five values freeze on every order line:
 * `classAtOrder`, `marginPctAtOrder`, `sellerNetPaise` and `staffPriceId`
 * here, plus `tierAtOrder` on the parent `so`. TD-003 adds two more:
 * `baseUnitsPerBoxAtOrder` and `baseUnitAtOrder` — QR-001 existed precisely
 * because nothing froze the conversion factor. **None of these seven values
 * is ever re-read from the SKU or the matrix once the line exists** — a
 * placed order never re-derives its price (BR-045).
 *
 * DATA_MODEL.md's own ENT-28 field list omits `sellerNetPaise`, which
 * BR-045's prose explicitly requires "on the line" — treated here as a gap
 * in that document, not a reason to drop a rule BR-045 states plainly. Fixed
 * in this session's DATA_MODEL.md update.
 *
 * `ratePaise` is the buyer-facing rate — ex-GST, per base unit (BR-055,
 * Q1/Q2) — frozen at creation via pricing.ts. `taxablePaise`/`totalPaise`/
 * `taxSplit` are the computed line money, stored so BR-301 holds ("the
 * total does not change between screen and paper") without recomputing it
 * from possibly-changed inputs later.
 */
const soLineSchema = new Schema(
  {
    soId: { type: Schema.Types.ObjectId, ref: 'So', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', required: true },
    boxes: { type: Number, required: true, min: 1 },
    ratePaise: { type: Number, required: true },
    // DATA_MODEL.md §2.3 — QR-001 is now answered (per base unit); one
    // permitted value kept as an explicit, self-documenting column rather
    // than silently dropping the guard the open question required.
    rateBasis: { type: String, enum: ['per_base_unit'], required: true, default: 'per_base_unit' },
    classAtOrder: { type: String, enum: ['A', 'B', 'C'], required: true },
    marginPctAtOrder: { type: Number, required: true, min: 0 },
    sellerNetPaise: { type: Number, required: true },
    staffPriceId: { type: Schema.Types.ObjectId, ref: 'RateOverride', default: null },
    baseUnitsPerBoxAtOrder: { type: Number, required: true },
    baseUnitAtOrder: { type: String, enum: ['LTR', 'KG', 'PC'], required: true },
    taxablePaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    taxSplit: {
      cgstPaise: { type: Number, required: true },
      sgstPaise: { type: Number, required: true },
      igstPaise: { type: Number, required: true },
    },
  },
  { timestamps: true },
);

soLineSchema.index({ soId: 1 });

export type SoLineDocument = InferSchemaType<typeof soLineSchema>;
export const SoLine = model<SoLineDocument>('SoLine', soLineSchema, 'so_line');
