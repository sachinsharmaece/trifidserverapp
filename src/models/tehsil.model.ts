import { Schema, model, type InferSchemaType } from 'mongoose';
import { PINCODE_PATTERN, normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';

/** Tehsils (sub-district areas) used to place buyers and sellers. Unique per state + district + name. */
const tehsilSchema = new Schema(
  {
    state: { ...textField(60), required: true },
    district: { ...textField(80), required: true },
    name: { ...textField(80), required: true },
    /** "state|district|name" in lower case, filled in automatically, so the same tehsil cannot be added twice. */
    key: { type: String, required: true },
    pincodes: {
      type: [{ type: String, match: [PINCODE_PATTERN, 'pincode must be 6 digits'] }],
      default: [],
    },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
  },
  { collection: 'tehsils', timestamps: true },
);

tehsilSchema.index({ key: 1 }, { unique: true });
tehsilSchema.index({ pincodes: 1 });

tehsilSchema.pre('validate', function () {
  if (this.state && this.district && this.name) {
    this.key = [this.state, this.district, this.name].map(normaliseKey).join('|');
  }
});

export type Tehsil = InferSchemaType<typeof tehsilSchema>;
export const TehsilModel = model('Tehsil', tehsilSchema);
