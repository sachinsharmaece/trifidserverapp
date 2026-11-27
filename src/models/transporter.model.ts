import { Schema, model, type InferSchemaType } from 'mongoose';
import { refField, textField } from './_fields.js';

/** A transport company bills can be booked with (reference-copy branch; reference Transporter master). */
const transporterSchema = new Schema(
  {
    name: { ...textField(120), required: true },
    nameKey: { type: String, required: true },
    createdBy: { ...refField('User'), required: true },
  },
  { collection: 'transporters', timestamps: true, versionKey: false },
);

transporterSchema.index({ nameKey: 1 }, { unique: true });

export type Transporter = InferSchemaType<typeof transporterSchema>;
export const TransporterModel = model('Transporter', transporterSchema);
