import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-39 `movement`. BR-176 — two dispatch modes, both legs. BR-071 — the
 * Logistics DTO carries no firm name on either side and no money at all;
 * enforced by movement.dto.ts, not by this schema (the schema itself may
 * store what it needs — the wall is a response-shaping concern).
 */
const movementSchema = new Schema(
  {
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    leg: { type: Number, enum: [1, 2], required: true },
    mode: { type: String, enum: ['transport', 'bus'], required: true },
    transporter: { type: String, default: null },
    lr: { type: String, default: null }, // mandatory on transport mode, optional on bus
    busNo: { type: String, default: null },
    driver: { type: String, default: null },
    driverMobile: { type: String, default: null },
    photoRef: { type: String, default: null },
    freightTerms: { type: String, enum: ['prepaid', 'to_pay'], required: true },
    freightAmountPaise: { type: Number, required: true },
    dispatchedAt: { type: Date, required: true, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

movementSchema.index({ chainId: 1, leg: 1 }, { unique: true });

export type MovementDocument = InferSchemaType<typeof movementSchema>;
export const Movement = model<MovementDocument>('Movement', movementSchema, 'movement');
