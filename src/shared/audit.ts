import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { AuditEventModel } from '../models/index.js';
import { unauthenticated } from './errors.js';

interface AuditEntry {
  /** What happened, like 'product.update'. */
  action: string;
  /** Model name of the changed record, like 'Product'. */
  entityType: string;
  entityId: string;
  /** Only the fields that changed (see `onlyChanged`). Never put passwords in here. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Pass the transaction session when the change is part of a transaction, so both succeed or both fail. */
  session?: ClientSession;
}

/** Writes one line to the append-only audit log: who (from the signed-in user) did what to which record. */
export async function writeAudit(req: Request, entry: AuditEntry): Promise<void> {
  const actor = req.user;
  if (!actor) throw unauthenticated(); // audited actions always sit behind requireAuth

  const { session, ...fields } = entry;
  await AuditEventModel.create(
    [
      {
        ...fields,
        actorId: actor.id,
        actorRole: actor.role,
        requestId: req.requestId,
        ip: req.ip ?? '',
      },
    ],
    session ? { session } : {},
  );
}

/** Values are the same if they are equal, or are lists/objects holding the same things (like two pincode lists). */
function isSame(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Keeps only the fields whose value differs, so the audit log shows exactly what changed. */
export function onlyChanged(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed = Object.keys(after).filter((key) => !isSame(before[key], after[key]));
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}
