import { CallLog, } from '../../../models/CallLog.js';
import { Employee } from '../../../models/Employee.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
function toDto(row, employeeName = '—') {
    return {
        callLogId: row._id.toString(),
        buyerId: row.buyerId.toString(),
        employeeId: row.employeeId.toString(),
        employeeName,
        direction: row.direction ?? null,
        at: row.at.toISOString(),
        kind: row.kind,
        outcome: row.outcome ?? null,
        note: row.note,
        producedAskId: row.producedAskId ? row.producedAskId.toString() : null,
        listingLineId: row.listingLineId ? row.listingLineId.toString() : null,
        updateKind: row.updateKind ?? null,
        updateValue: row.updateValue ?? null,
        promiseDueAt: row.promiseDueAt ? row.promiseDueAt.toISOString() : null,
        promiseFulfilledAt: row.promiseFulfilledAt ? row.promiseFulfilledAt.toISOString() : null,
    };
}
/**
 * A `call` names how it went and which way it ran (the zod schema already
 * enforces this on the request; re-checked here so a caller that builds the
 * input by hand — a proxy path, a script — gets the same plain-English
 * refusal). An `update_request` names which field the buyer wants changed.
 */
export async function createCallLog(input, actor) {
    if (input.kind === 'call' && (!input.outcome || !input.direction)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'A call log requires an outcome and which way the call ran.',
        });
    }
    if (input.kind === 'update_request' && !input.updateKind) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'An update request must say which field is changing.',
        });
    }
    const created = await CallLog.create({
        buyerId: input.buyerId,
        employeeId: actor.employeeId,
        direction: input.direction ?? null,
        kind: input.kind,
        outcome: input.outcome ?? null,
        note: input.note,
        producedAskId: input.producedAskId ?? null,
        listingLineId: input.listingLineId ?? null,
        updateKind: input.updateKind ?? null,
        updateValue: input.updateValue ?? null,
        promiseDueAt: input.promiseDueAt ? new Date(input.promiseDueAt) : null,
    });
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'call_log',
        entityId: created._id,
        field: 'create',
        newValue: { kind: created.kind, buyerId: input.buyerId },
        correlationId: actor.correlationId,
    });
    const employee = await Employee.findById(actor.employeeId);
    return toDto(created, employee?.person ?? '—');
}
async function employeeNamesByRow(rows) {
    const employees = await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } });
    return new Map(employees.map((e) => [e._id.toString(), e.person]));
}
export async function listCallLogsForBuyer(buyerId) {
    const rows = await CallLog.find({ buyerId }).sort({ at: -1 });
    const nameById = await employeeNamesByRow(rows);
    return rows.map((r) => toDto(r, nameById.get(r.employeeId.toString()) ?? '—'));
}
/** The Today worklist's "Promised" bucket — a due date has arrived and nobody has closed it out. */
export async function listDuePromises(now = new Date()) {
    const rows = await CallLog.find({
        promiseDueAt: { $ne: null, $lte: now },
        promiseFulfilledAt: null,
    }).sort({ promiseDueAt: 1 });
    const nameById = await employeeNamesByRow(rows);
    return rows.map((r) => toDto(r, nameById.get(r.employeeId.toString()) ?? '—'));
}
