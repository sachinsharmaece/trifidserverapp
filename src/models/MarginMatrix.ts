import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-43 `margin_matrix`. BR-040 — three SKU classes × four rate tiers, set
 * once in the admin master, driving every pre-filled rate. `pct` is a
 * decimal fraction of margin over landed cost (0.0572 for 5.72%), never
 * negative (BR-021 — a negative-margin line is impossible by construction).
 *
 * BR-046 — effective-dating is forward only: a change never edits a cell in
 * place, it inserts a new row with a later `effectiveFrom`. The cell that
 * applies to an order is the one with the latest `effectiveFrom` that is not
 * after "now" — resolved in pricing.service.ts, never here.
 *
 * `creditPct` — BR-054, a parked axis for a future credit surcharge. Present
 * on the schema, always zero, read by nothing yet.
 *
 * ⚠️ The twelve values themselves are still not supplied — QR-007 remains
 * open. Production code seeds nothing; see pricing.service.ts.
 */
const marginMatrixSchema = new Schema(
  {
    class: { type: String, enum: ['A', 'B', 'C'], required: true },
    tier: { type: String, enum: ['Distributor', 'Dealer', 'Retailer', 'Trader'], required: true },
    pct: { type: Number, required: true, min: 0 },
    creditPct: { type: Number, required: true, default: 0, min: 0 },
    effectiveFrom: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

marginMatrixSchema.index({ class: 1, tier: 1, effectiveFrom: -1 });

export type MarginMatrixDocument = InferSchemaType<typeof marginMatrixSchema>;
export const MarginMatrix = model<MarginMatrixDocument>(
  'MarginMatrix',
  marginMatrixSchema,
  'margin_matrix',
);
