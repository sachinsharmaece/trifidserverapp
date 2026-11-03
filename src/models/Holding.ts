import { Schema, model, type InferSchemaType } from 'mongoose';
import { CALL_OUTCOMES } from './CallLog.js';

/**
 * LOCK-34 `holding`. One period of one staff member holding one party (a
 * buyer). A party has at most one OPEN holding — enforced by the partial
 * unique index below, which is also what makes a Pool claim race safe: the
 * second claim fails in the database, not in the screen.
 *
 * A party with no open holding is in the Pool. "Uncalled", day counts and the
 * Pool sections are all worked out from these rows and the call log; none is
 * stored. Nothing about holding state is written onto the buyer.
 */
export const HOLDING_KINDS = ['lead', 'claim', 'book'] as const;
export const HOLDING_VIA = [
  'intake',
  'own_call',
  'pool_claim',
  'desk_assign',
  'go_live',
  'conversion',
  // A deactivated caller's holdings handed to a named person. Like go_live and
  // own_call, never counted as uncalled.
  'transfer',
] as const;
export const HOLDING_SOURCES = ['meta', 'fa', 'app', 'call', 'staff', 'import'] as const;
export const HOLDING_ENDS = ['ordered', 'billed', 'released'] as const;

/** Why a holder let a party go: the call outcomes, less "placed an order". */
export type ReleaseReason = Exclude<(typeof CALL_OUTCOMES)[number], 'placed_an_order'>;
export const RELEASE_REASONS = CALL_OUTCOMES.filter(
  (o): o is ReleaseReason => o !== 'placed_an_order',
);

const holdingSchema = new Schema(
  {
    partyId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    holderId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    kind: { type: String, enum: HOLDING_KINDS, required: true },
    via: { type: String, enum: HOLDING_VIA, required: true },
    source: { type: String, enum: HOLDING_SOURCES },
    startedAt: { type: Date, required: true },
    windowOpenedAt: { type: Date },
    backlog: { type: Boolean },
    reason: { type: String, enum: RELEASE_REASONS },
    reasonAt: { type: Date },
    endedAt: { type: Date },
    end: { type: String, enum: HOLDING_ENDS },
    // Released with no reason logged: shown as "owner did not diagnose".
    systemMarked: { type: Boolean },
    isOpen: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

holdingSchema.index({ partyId: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
holdingSchema.index({ holderId: 1, isOpen: 1 });
holdingSchema.index({ isOpen: 1, endedAt: 1 });

export type HoldingDocument = InferSchemaType<typeof holdingSchema>;
export const Holding = model<HoldingDocument>('Holding', holdingSchema, 'holding');
