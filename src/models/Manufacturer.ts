import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-11 `manufacturer`. Purchase-desk v2 — `state`/`createdBy`: a
 * Purchase-raised master is usable in a seller's catalogue immediately
 * (`state: 'draft'`) but cannot back a live listing until Admin confirms it
 * (`state: 'live'`, the default — every row created through `/admin/*`
 * stays exactly as before). See `modules/catalog/catalog.service.ts`'s
 * `createManufacturerDraft` and `listing.service.ts#createListing`'s guard.
 */
const manufacturerSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    active: { type: Boolean, required: true, default: true },
    state: { type: String, enum: ['draft', 'live'], required: true, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true },
);

export type ManufacturerDocument = InferSchemaType<typeof manufacturerSchema>;
export const Manufacturer = model<ManufacturerDocument>(
  'Manufacturer',
  manufacturerSchema,
  'manufacturer',
);
