import { Schema, model, type InferSchemaType } from 'mongoose';

// ENT-11 `manufacturer`.
const manufacturerSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export type ManufacturerDocument = InferSchemaType<typeof manufacturerSchema>;
export const Manufacturer = model<ManufacturerDocument>(
  'Manufacturer',
  manufacturerSchema,
  'manufacturer',
);
