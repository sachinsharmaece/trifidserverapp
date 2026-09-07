import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-54 `config`. TD-009 — business values (payment windows, the margin
 * matrix, run times, caps and thresholds) live here, editable by Admin, never
 * in .env or hardcoded. This M1/M2 session ships the shape only; the module
 * that first needs a value seeds it.
 */
const configSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    version: { type: Number, required: true, default: 1 },
    updatedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

export type ConfigDocument = InferSchemaType<typeof configSchema>;
export const Config = model<ConfigDocument>('Config', configSchema, 'config');
