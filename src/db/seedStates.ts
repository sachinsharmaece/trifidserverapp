import { State } from '../models/State.js';
import { STATE_SEED } from '../config/states.js';

/**
 * Phase 1 — the State master exists before any form or the location
 * migration needs it. Idempotent, keyed on the GST state code; the name is
 * only written on insert, so a later correction made in Manage is not
 * overwritten on the next boot.
 */
export async function seedStates(): Promise<void> {
  for (const state of STATE_SEED) {
    await State.updateOne(
      { gstStateCode: state.gstStateCode },
      { $setOnInsert: { gstStateCode: state.gstStateCode, name: state.name } },
      { upsert: true },
    );
  }
}
