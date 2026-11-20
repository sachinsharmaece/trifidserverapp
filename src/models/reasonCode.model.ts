import { Schema, model, type InferSchemaType } from 'mongoose';
import { REASON_CODE_CONTEXTS } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * Reasons staff pick from dropdowns (buyer said no, order cancelled, refund...). Each code belongs to one
 * context and appears only in that dropdown, never pre-selected (SRS-MST-07). Inactive codes are hidden.
 */
const reasonCodeSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [/^[A-Z][A-Z0-9_]*$/, 'code must be UPPER_SNAKE_CASE'],
      maxlength: 40,
    },
    label: { ...textField(120), required: true },
    context: { type: String, enum: REASON_CODE_CONTEXTS, required: true },
    /** Display order in the dropdown (ascending). */
    sort: { ...intField(0, 10_000), default: 100 },
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
  },
  { collection: 'reason_codes', timestamps: true },
);

reasonCodeSchema.index({ code: 1 }, { unique: true });
reasonCodeSchema.index({ context: 1, active: 1, sort: 1 });

export type ReasonCode = InferSchemaType<typeof reasonCodeSchema>;
export const ReasonCodeModel = model('ReasonCode', reasonCodeSchema);
