import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * New — M7, BR-178. **A physical/freight grouping only.** Several leg-2
 * `Movement`s riding in the same vehicle to the same buyer/location on the
 * same day get one shared reference for the transporter; nothing here
 * touches billing — each SO still gets exactly one Marg invoice (`QR-014`,
 * unchanged). Do not add an invoice-level or SellerBill/MargBill field here.
 */
const consolidationSchema = new Schema(
  {
    consolidationNo: { type: String, required: true, unique: true },
    movementIds: [{ type: Schema.Types.ObjectId, ref: 'Movement', required: true }],
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

export type ConsolidationDocument = InferSchemaType<typeof consolidationSchema>;
export const Consolidation = model<ConsolidationDocument>(
  'Consolidation',
  consolidationSchema,
  'consolidation',
);
