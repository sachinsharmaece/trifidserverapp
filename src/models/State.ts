import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-63 `state`. Phase 1 location masters — the top of State → District →
 * Tehsil. `gstStateCode` is the two-digit GST state code (the first two
 * characters of every GSTIN issued there), which is what the buyer form
 * checks a GSTIN against. Seeded at startup from `STATE_SEED`
 * (db/seedStates.ts); an Admin or team leader may add more. Name and code
 * are each unique, case-insensitively for the name.
 */
const stateSchema = new Schema(
  {
    name: { type: String, required: true },
    gstStateCode: { type: String, required: true, match: /^\d{2}$/ },
  },
  { timestamps: true },
);

stateSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
stateSchema.index({ gstStateCode: 1 }, { unique: true });

export type StateDocument = InferSchemaType<typeof stateSchema>;
export const State = model<StateDocument>('State', stateSchema, 'state');
