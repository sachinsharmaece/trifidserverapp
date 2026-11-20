import { Schema, model, type InferSchemaType } from 'mongoose';
import { normaliseKey } from '../shared/validators.js';
import { refField, textField } from './_fields.js';

/** Product manufacturers, e.g. "Bayer". Never deleted: set `active: false` instead. */
const manufacturerSchema = new Schema(
  {
    name: { ...textField(150), required: true },
    /** Lower-case copy of `name`, filled in automatically, so "Bayer" and " bayer" count as the same name. */
    nameLower: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
  },
  { collection: 'manufacturers', timestamps: true },
);

manufacturerSchema.index({ nameLower: 1 }, { unique: true });

manufacturerSchema.pre('validate', function () {
  this.nameLower = normaliseKey(this.name);
});

export type Manufacturer = InferSchemaType<typeof manufacturerSchema>;
export const ManufacturerModel = model('Manufacturer', manufacturerSchema);
