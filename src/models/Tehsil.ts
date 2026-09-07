import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-10 `tehsil`. BR-080 — tehsil is the resolver's unit. District is a
 * heading only; nothing in the resolver reads it. **Name is not unique** —
 * thirteen names repeat in the MP master — so every picker and every seed
 * script must disambiguate by district, never by name alone.
 */
const tehsilSchema = new Schema(
  {
    name: { type: String, required: true },
    district: { type: String, required: true },
    state: { type: String, required: true },
  },
  { timestamps: true },
);

tehsilSchema.index({ name: 1, district: 1 }, { unique: true });
tehsilSchema.index({ district: 1 });

export type TehsilDocument = InferSchemaType<typeof tehsilSchema>;
export const Tehsil = model<TehsilDocument>('Tehsil', tehsilSchema, 'tehsil');
