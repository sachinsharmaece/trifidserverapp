import type { ClientSession, Types } from 'mongoose';
import { ChainEvent } from '../../models/ChainEvent.js';

export interface ChainEventInput {
  chainId: Types.ObjectId | string;
  type: string;
  refCollection: string;
  refId: Types.ObjectId | string;
  actorId: Types.ObjectId | string;
  actorType: 'counterparty' | 'staff' | 'system';
  reason?: string;
  oldValue?: unknown;
  newValue?: unknown;
  summary: string;
}

/** BR-037 — the only way to write to chain_event. See models/ChainEvent.ts. */
export async function writeChainEvent(
  entry: ChainEventInput,
  session?: ClientSession,
): Promise<void> {
  await ChainEvent.create([{ ...entry }], { session });
}
