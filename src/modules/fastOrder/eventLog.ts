import type { ClientSession, Types } from 'mongoose';
import { EventLogModel } from '../../models/index.js';
import type { EventCategory } from '../../shared/enums.js';

export interface LogEventInput {
  category: EventCategory;
  entityType: string;
  entityId: Types.ObjectId | string;
  partyId?: Types.ObjectId | string | null;
  action: string;
  /** Empty when the system did it. */
  userId?: Types.ObjectId | string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

/** Adds one line to the event log (inside the caller's transaction when a session is given). */
export async function logEvent(entry: LogEventInput, session?: ClientSession | null) {
  await EventLogModel.create(
    [
      {
        category: entry.category,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...(entry.partyId ? { partyId: entry.partyId } : {}),
        action: entry.action,
        ...(entry.userId ? { userId: entry.userId } : {}),
        ...(entry.oldValue === undefined ? {} : { oldValue: entry.oldValue }),
        ...(entry.newValue === undefined ? {} : { newValue: entry.newValue }),
        ...(entry.reason ? { reason: entry.reason } : {}),
        at: new Date(),
      },
    ],
    { session: session ?? null },
  );
}
