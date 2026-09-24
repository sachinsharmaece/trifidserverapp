import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-26 `chain`. BR-030 — one chain per trade, exactly six stages,
 * strictly ordered. `stage` is the coarse chain-strip position (BR-031);
 * `so.state` (models/So.ts) carries the finer ST-01 state.
 *
 * `source` is for reporting only — nothing branches on it (CH §1.5).
 * `'listed' | 'inquiry'` are the two values the Charter names. The WF-05
 * pile fan-out (a buyer taking a listed rate) writes `'listed'`; every other
 * path — ask/quote acceptance, a pool, the staff `createSo` — writes
 * `'inquiry'`. Chains created before the enquiry-journey change all read
 * `'inquiry'`, whichever path produced them.
 *
 * ⚠️ Numbering scheme is provisional — QR-032.
 */
const chainSchema = new Schema(
  {
    chainNo: { type: String, required: true, unique: true },
    source: { type: String, enum: ['listed', 'inquiry'], required: true },
    stage: {
      type: String,
      enum: ['so', 'payment', 'po', 'leg1', 'marg', 'dispatch', 'done'],
      required: true,
      default: 'so',
    },
    openedAt: { type: Date, required: true, default: () => new Date() },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

chainSchema.index({ stage: 1 });

export type ChainDocument = InferSchemaType<typeof chainSchema>;
export const Chain = model<ChainDocument>('Chain', chainSchema, 'chain');
