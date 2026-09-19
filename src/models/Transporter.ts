import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New — M7. BR-176's dispatch modes name a transporter by free text on
 * `Movement`; this is the master list Logistics picks from, kept separate
 * from `Movement.transporter` (still a plain string, untouched) so existing
 * dispatch records need no backfill. `movementId`-level entries may or may
 * not reference one of these rows.
 */
const transporterSchema = new Schema(
  {
    name: { type: String, required: true },
    mobile: { type: String, default: null },
    vehicleType: { type: String, default: null },
    active: { type: Boolean, required: true, default: true },
    notes: { type: String, default: null },
  },
  { timestamps: true },
);

transporterSchema.index({ name: 1 }, { unique: true });
transporterSchema.index({ active: 1 });

export type TransporterDocument = InferSchemaType<typeof transporterSchema>;
export const Transporter = model<TransporterDocument>(
  'Transporter',
  transporterSchema,
  'transporter',
);
