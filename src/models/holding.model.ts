import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  CALL_OUTCOMES,
  HOLDING_ENDS,
  HOLDING_KINDS,
  HOLDING_VIAS,
  INTAKE_SOURCES,
} from '../shared/enums.js';
import { refField } from './_fields.js';

/**
 * One period of one caller holding one buyer (reference LOCK-34 Holding). A buyer has at most one OPEN holding: the
 * partial unique index below makes "first claim wins" safe in the database, not just in code. A buyer with no open
 * holding is in the Pool.
 *
 * The clock (modules/dormancy) opens a reason window when the time runs out (`windowOpenedAt`), and releases the
 * buyer to the Pool when the window ends. `reason` is the holder's answer to "Why did he go?".
 */
const holdingSchema = new Schema(
  {
    partyId: { ...refField('Buyer'), required: true },
    holderId: { ...refField('User'), required: true },
    kind: { type: String, enum: HOLDING_KINDS, required: true },
    via: { type: String, enum: HOLDING_VIAS, required: true },
    /** Intake only: where the new buyer came from. */
    source: { type: String, enum: INTAKE_SOURCES },
    startedAt: { type: Date, required: true },
    windowOpenedAt: Date,
    backlog: { type: Boolean, required: true, default: false },
    reason: { type: String, enum: CALL_OUTCOMES },
    reasonAt: Date,
    endedAt: Date,
    end: { type: String, enum: HOLDING_ENDS },
    /** Released with no reason logged. */
    systemMarked: { type: Boolean, required: true, default: false },
    isOpen: { type: Boolean, required: true, default: true },
  },
  { collection: 'holdings', timestamps: true, versionKey: false },
);

holdingSchema.index(
  { partyId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_holding_per_party' },
);
holdingSchema.index({ holderId: 1, isOpen: 1 });
holdingSchema.index({ partyId: 1, endedAt: -1 });

export type Holding = InferSchemaType<typeof holdingSchema>;
export const HoldingModel = model('Holding', holdingSchema);
