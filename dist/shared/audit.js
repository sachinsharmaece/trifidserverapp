import { AuditLog } from '../models/AuditLog.js';
/**
 * The only way to write to audit_log. CH §17.7 — every manual action and
 * override writes an immutable entry: who, what, when, old value → new value,
 * and why where a reason is required.
 *
 * Pass the session of the surrounding transaction so the audit row commits or
 * rolls back with the business write it describes.
 */
export async function writeAuditLog(entry, session) {
    await AuditLog.create([{ ...entry }], { session });
}
