import { Ask } from '../../../models/Ask.js';
import { So } from '../../../models/So.js';
import { Buyer } from '../../../models/Buyer.js';
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
/**
 * 28 Oct — a call action taken on the call page (raising an ask, accepting a
 * rate, declining, a promoted-offer decision) is also a call: it writes one
 * row to the call history, so the history shows every call, not only those
 * saved with "Record a call outcome". The call note also stays on the ask or
 * order itself (proxyLog), as before.
 */
export async function recordCallAction(input) {
    const buyer = await Buyer.findOne({ counterpartyId: input.buyerCounterpartyId }, { _id: 1 });
    if (!buyer)
        return;
    await CallLog.create({
        buyerId: buyer._id,
        employeeId: input.employeeId,
        direction: input.direction ?? null,
        at: input.at ?? new Date(),
        kind: 'call',
        outcome: input.outcome,
        note: input.note,
        producedAskId: input.producedAskId ?? null,
    });
}
const ACTION_ROW = {
    raise_ask: { outcome: 'asked_for_a_rate', prefix: '' },
    accept_fill: { outcome: 'placed_an_order', prefix: '' },
    decline_ask: { outcome: null, prefix: 'Declined the ask. ' },
    accept_promotion: { outcome: null, prefix: 'Accepted the promoted offer. ' },
    reject_promotion: { outcome: null, prefix: 'Turned down the promoted offer. ' },
};
/**
 * 28 Oct — one-off: calls logged on the call page before `recordCallAction`
 * existed kept their note only in the ask's or order's `proxyLog`. Adds the
 * matching call-history row for each (original time and staff member). A row
 * already within 10 s of the entry, for the same buyer and staff member, counts
 * as there — so it is safe to run twice, and skips calls made after the fix.
 * An order's own accept_fill entry is skipped: the ask's carries the same call.
 */
export async function backfillCallHistory(options) {
    const result = {
        found: 0,
        alreadyThere: 0,
        added: 0,
        skipped: 0,
        byAction: {},
    };
    const sources = [];
    for (const ask of await Ask.find({ 'proxyLog.0': { $exists: true } }, { buyerId: 1, proxyLog: 1 })) {
        sources.push({
            buyerId: ask.buyerId,
            askId: ask._id,
            entries: ask.proxyLog,
        });
    }
    for (const so of await So.find({ 'proxyLog.0': { $exists: true } }, { buyerId: 1, proxyLog: 1 })) {
        sources.push({
            buyerId: so.buyerId,
            askId: null,
            entries: so.proxyLog.filter((e) => e.action !== 'accept_fill'),
        });
    }
    for (const source of sources) {
        for (const entry of source.entries) {
            const shape = ACTION_ROW[entry.action];
            if (!shape)
                continue;
            result.found += 1;
            if (!(await Buyer.exists({ _id: source.buyerId }))) {
                result.skipped += 1;
                continue;
            }
            const at = new Date(entry.at);
            const there = await CallLog.exists({
                buyerId: source.buyerId,
                employeeId: entry.actingStaffId,
                at: { $gte: new Date(at.getTime() - 10_000), $lte: new Date(at.getTime() + 10_000) },
            });
            if (there) {
                result.alreadyThere += 1;
                continue;
            }
            result.added += 1;
            result.byAction[entry.action] = (result.byAction[entry.action] ?? 0) + 1;
            if (options.apply) {
                await CallLog.create({
                    buyerId: source.buyerId,
                    employeeId: entry.actingStaffId,
                    direction: null,
                    at,
                    kind: 'call',
                    outcome: shape.outcome,
                    note: `${shape.prefix}${entry.callNote}`,
                    producedAskId: source.askId,
                });
            }
        }
    }
    return result;
}
