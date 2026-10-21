import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Technical master — the active-ingredient names a product can carry. Before
 * this existed a technical was only ever the `Product.technical` string, so it
 * could not exist without a product. `Product.technical` stays that string (the
 * buyer app, pickers and enquiries all key on it); this master is where the
 * admin picks from, and `catalog.service.ts#ensureTechnical` keeps the two in
 * step. Same `state`/`createdBy` draft/live shape as `Manufacturer`.
 */
const technicalSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    active: { type: Boolean, required: true, default: true },
    state: { type: String, enum: ['draft', 'live'], required: true, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true },
);

export type TechnicalDocument = InferSchemaType<typeof technicalSchema>;
export const Technical = model<TechnicalDocument>('Technical', technicalSchema, 'technical');
