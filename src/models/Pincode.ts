import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-65 `pincode`. Phase 1 location masters — a pincode → tehsil mapping,
 * which gives the district and state through the tehsil. A known pincode
 * fills a form's location in; an unknown one is saved as `unverified` with
 * the tehsil the staff member picked, for an Admin to check on
 * Manage › Pincodes. **Stored only** — listing reach and the resolver stay
 * tehsil-based (BR-081); nothing reads a pincode to decide visibility.
 */
const pincodeSchema = new Schema(
  {
    pincode: { type: String, required: true, unique: true, match: /^[1-9]\d{5}$/ },
    tehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', required: true },
    status: { type: String, enum: ['verified', 'unverified'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

pincodeSchema.index({ status: 1, pincode: 1 });

export type PincodeDocument = InferSchemaType<typeof pincodeSchema>;
export const Pincode = model<PincodeDocument>('Pincode', pincodeSchema, 'pincode');
