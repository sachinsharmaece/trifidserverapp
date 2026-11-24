import { AuditEventModel } from '../models/index.js';
import { unauthenticated } from './errors.js';
/** Writes one line to the append-only audit log: who (from the signed-in user) did what to which record. */
export async function writeAudit(req, entry) {
    const actor = req.user;
    if (!actor)
        throw unauthenticated(); // audited actions always sit behind requireAuth
    const { session, ...fields } = entry;
    await AuditEventModel.create([
        {
            ...fields,
            actorId: actor.id,
            actorRole: actor.role,
            requestId: req.requestId,
            ip: req.ip ?? '',
        },
    ], session ? { session } : {});
}
/** Values are the same if they are equal, or are lists/objects holding the same things (like two pincode lists). */
function isSame(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}
/** Keeps only the fields whose value differs, so the audit log shows exactly what changed. */
export function onlyChanged(before, after) {
    const changed = Object.keys(after).filter((key) => !isSame(before[key], after[key]));
    return {
        before: Object.fromEntries(changed.map((key) => [key, before[key]])),
        after: Object.fromEntries(changed.map((key) => [key, after[key]])),
    };
}
//# sourceMappingURL=audit.js.map