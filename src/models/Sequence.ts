import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Technical support collection, not an `ENT` (same category as `rate_limit`
 * and `worker_heartbeat` in DATA_MODEL.md §6 — no business meaning of its
 * own). QR-032 — document numbering is still provisional; this is what
 * generates SO-26-0417, PO-26-0184 and C-01 style numbers: sequential per
 * document type per financial year, gapless. `nextSequence` in
 * modules/chain/chain.numbering.ts increments this atomically inside the
 * same transaction as the document it numbers, so a crash mid-write can
 * never produce a gap or a duplicate.
 */
const sequenceSchema = new Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

export type SequenceDocument = InferSchemaType<typeof sequenceSchema>;
export const Sequence = model<SequenceDocument>('Sequence', sequenceSchema, 'sequence');
