import type { ClientSession, Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog.js';

export type ActorType = 'counterparty' | 'staff' | 'system';

export interface AuditEntry {
  actorId: Types.ObjectId | string;
  actorType: ActorType;
  entity: string;
  entityId: Types.ObjectId | string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  correlationId: string;
}

/**
 * The only way to write to audit_log. CH §17.7 — every manual action and
 * override writes an immutable entry: who, what, when, old value → new value,
 * and why where a reason is required.
 *
 * Pass the session of the surrounding transaction so the audit row commits or
 * rolls back with the business write it describes.
 */
export async function writeAuditLog(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLog.create([{ ...entry }], { session });
}
