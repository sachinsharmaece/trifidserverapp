import { ChainEvent } from '../../models/ChainEvent.js';
/** BR-037 — the only way to write to chain_event. See models/ChainEvent.ts. */
export async function writeChainEvent(entry, session) {
    await ChainEvent.create([{ ...entry }], { session });
}
