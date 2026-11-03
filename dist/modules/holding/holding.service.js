import { Types } from 'mongoose';
import { SALES_CALLER_POSITIONS } from '../../config/positions.js';
import { withTransaction } from '../../db/transaction.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { Buyer } from '../../models/Buyer.js';
import { CallLog } from '../../models/CallLog.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Employee } from '../../models/Employee.js';
import { Holding, RELEASE_REASONS, } from '../../models/Holding.js';
import { Sequence } from '../../models/Sequence.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { logger } from '../../shared/logger.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { billsFor } from './holding.bills.js';
import { clockStart, daysBetween, istMidnight } from './holding.rules.js';
import { assertHoldingEnabled, getSettings, isHoldingEnabled, } from './holding.settings.js';
const id = (value) => String(value);
const oid = (value) => new Types.ObjectId(value);
export const refuse = (messageEn, field) => new AppError({ code: 'VALIDATION_FAILED', messageEn, ...(field ? { field } : {}) });
const isDuplicateKey = (error) => error?.code === 11000;
// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
/** A caller: an active Sales Executive or Sr. Sales Executive. */
export async function isCaller(employeeId) {
    return Boolean(await Employee.exists({
        _id: employeeId,
        active: true,
        positions: { $in: SALES_CALLER_POSITIONS },
    }));
}
// ---------------------------------------------------------------------------
// Uncalled — always worked out, never stored
// ---------------------------------------------------------------------------
// A lead or claim taken at go-live, from the holder's own call, by conversion or by
// transfer is never "uncalled"; only one dealt to him (intake), claimed or desk-assigned is.
const UNCALLED_VIA = ['intake', 'pool_claim', 'desk_assign'];
// Any outcome counts, "no answer" included. A bare note is not a call.
const CALL_KINDS = ['call', 'update_request'];
/** Buyers whose firm was rejected, blacklisted or deleted: out of every count and out of the Pool. */
export async function ineligiblePartyIds(partyIds, session) {
    if (partyIds.length === 0)
        return new Set();
    const buyers = await Buyer.find({ _id: { $in: partyIds } }, { counterpartyId: 1 })
        .session(session ?? null)
        .lean();
    const bad = await Counterparty.find({
        _id: { $in: buyers.map((b) => b.counterpartyId) },
        $or: [{ status: { $in: ['rejected', 'blacklisted'] } }, { deletedAt: { $ne: null } }],
    }, { _id: 1 })
        .session(session ?? null)
        .lean();
    const badIds = new Set(bad.map((c) => id(c._id)));
    return new Set(buyers.filter((b) => badIds.has(id(b.counterpartyId))).map((b) => id(b._id)));
}
/** For each holder: the open lead/claim holdings he has not yet called. */
export async function uncalledByHolder(holderIds, session) {
    const result = new Map(holderIds.map((h) => [h, []]));
    if (holderIds.length === 0)
        return result;
    const holdings = await Holding.find({
        holderId: { $in: holderIds },
        isOpen: true,
        kind: { $in: ['lead', 'claim'] },
        via: { $in: UNCALLED_VIA },
    })
        .session(session ?? null)
        .lean();
    if (holdings.length === 0)
        return result;
    const partyIds = [...new Set(holdings.map((h) => id(h.partyId)))];
    const [bad, calls] = await Promise.all([
        ineligiblePartyIds(partyIds, session),
        CallLog.find({
            employeeId: { $in: holderIds },
            buyerId: { $in: partyIds },
            kind: { $in: CALL_KINDS },
        }, { employeeId: 1, buyerId: 1, at: 1 })
            .session(session ?? null)
            .lean(),
    ]);
    const latestCall = new Map();
    for (const call of calls) {
        const key = `${id(call.employeeId)}|${id(call.buyerId)}`;
        latestCall.set(key, Math.max(latestCall.get(key) ?? 0, call.at.getTime()));
    }
    for (const h of holdings) {
        const party = id(h.partyId);
        if (bad.has(party))
            continue;
        const called = latestCall.get(`${id(h.holderId)}|${party}`);
        if (called !== undefined && called >= h.startedAt.getTime())
            continue;
        result.get(id(h.holderId)).push({
            holdingId: id(h._id),
            partyId: party,
            holderId: id(h.holderId),
            startedAt: h.startedAt,
        });
    }
    return result;
}
// ---------------------------------------------------------------------------
// One at a time
// ---------------------------------------------------------------------------
const LOCK_KEY = 'holding-lock';
async function ensureLock() {
    try {
        await Sequence.updateOne({ key: LOCK_KEY }, { $setOnInsert: { seq: 0 } }, { upsert: true });
    }
    catch (error) {
        if (!isDuplicateKey(error))
            throw error;
    }
}
/**
 * Intakes, claims and desk assignments each run inside this: every one of them
 * first bumps the same lock row, so two at once conflict on it and one retries —
 * they cannot both read "49 uncalled" and push someone past the cap.
 */
export async function withHoldingLock(work) {
    await ensureLock();
    return withTransaction(async (session) => {
        await Sequence.updateOne({ key: LOCK_KEY }, { $inc: { seq: 1 } }, { session });
        return work(session);
    });
}
// ---------------------------------------------------------------------------
// Writing a holding (and its book-row mirror)
// ---------------------------------------------------------------------------
async function writeMirror(partyId, holderId, reason, session) {
    await BookAssignment.findOneAndUpdate({ buyerId: partyId }, { $set: { ownerEmployeeId: holderId, assignedAt: new Date(), assignedBy: holderId, reason } }, { upsert: true, session });
}
async function dropMirror(partyId, session) {
    await BookAssignment.deleteOne({ buyerId: partyId }, { session });
}
const MIRROR_REASON = {
    intake: 'Dealt as a new lead (LOCK-34).',
    own_call: 'Created from his own call (LOCK-34).',
    pool_claim: 'Claimed from the Pool (LOCK-34).',
    desk_assign: 'Assigned by the Team Leader (LOCK-34).',
    go_live: 'Held at go-live (LOCK-34).',
    conversion: 'Converted to a book (LOCK-34).',
    transfer: 'Handed over (LOCK-34).',
};
export async function openHolding(data, session) {
    const [holding] = await Holding.create([
        {
            partyId: data.partyId,
            holderId: data.holderId,
            kind: data.kind,
            via: data.via,
            ...(data.source ? { source: data.source } : {}),
            ...(data.backlog ? { backlog: true } : {}),
            startedAt: data.startedAt ?? new Date(),
            isOpen: true,
        },
    ], { session });
    if (!holding)
        throw new Error('Holding.create returned no document.');
    await writeMirror(data.partyId, data.holderId, MIRROR_REASON[data.via], session);
    return holding;
}
async function rank(ids, session) {
    const [uncalled, last] = await Promise.all([
        uncalledByHolder(ids, session),
        Holding.aggregate([
            { $match: { holderId: { $in: ids.map(oid) }, via: 'intake' } },
            { $group: { _id: '$holderId', last: { $max: '$startedAt' } } },
        ]).session(session),
    ]);
    const lastIntake = new Map(last.map((r) => [id(r._id), r.last.getTime()]));
    // Fewest uncalled first; on a tie the one whose last intake is oldest (never = oldest).
    return ids
        .map((i) => ({
        id: i,
        uncalled: uncalled.get(i)?.length ?? 0,
        lastIntake: lastIntake.get(i) ?? 0,
    }))
        .sort((a, b) => a.uncalled - b.uncalled || a.lastIntake - b.lastIntake || a.id.localeCompare(b.id));
}
async function pickIntakeHolder(cap, session) {
    const callers = await Employee.find({
        active: true,
        positions: { $in: SALES_CALLER_POSITIONS },
        receivingLeads: { $ne: false },
    }, { _id: 1 })
        .session(session)
        .lean();
    const ranked = await rank(callers.map((c) => id(c._id)), session);
    const open = ranked.find((r) => r.uncalled < cap);
    if (open)
        return open.id;
    // Everyone is at the cap (or none is receiving): the Team Leader takes the overflow, uncapped.
    const leaders = await Employee.find({ active: true, positions: 'SALES_LEADER' }, { _id: 1 })
        .session(session)
        .lean();
    const overflow = await rank(leaders.map((l) => id(l._id)), session);
    return overflow[0]?.id ?? null;
}
/**
 * §4.5 — called once from every place a buyer is created. With the switch off it
 * does nothing. It never throws: a failure here must not undo a registration, so
 * it is logged and the party simply waits in the Pool (the Team Leader sees it).
 *
 * `actorId` is the staff member who created the party, if one did. When that is a
 * caller, the party is his own call's: he holds it, and it never counts as uncalled.
 */
export async function assignNewParty(partyId, source, actorId) {
    const party = id(partyId);
    try {
        if (!(await isHoldingEnabled()))
            return;
        const settings = await getSettings();
        const ownCall = Boolean(actorId) && (source === 'staff' || source === 'call')
            ? await isCaller(actorId)
            : false;
        await withHoldingLock(async (session) => {
            if (await Holding.exists({ partyId: party, isOpen: true }).session(session))
                return;
            if (ownCall) {
                await openHolding({ partyId: party, holderId: actorId, kind: 'lead', via: 'own_call', source: 'call' }, session);
                return;
            }
            const holderId = await pickIntakeHolder(settings.uncalledCap, session);
            if (!holderId) {
                logger.error({ msg: 'LOCK-34: no caller and no Team Leader to take a new party', party });
                return;
            }
            await openHolding({ partyId: party, holderId, kind: 'lead', via: 'intake', source }, session);
        });
    }
    catch (error) {
        logger.error({ msg: 'LOCK-34: could not assign a new party', party, err: error });
    }
}
// ---------------------------------------------------------------------------
// Claim and desk assign (§4.7, §4.8)
// ---------------------------------------------------------------------------
async function takeFromPool(partyId, holderId, via) {
    assertValidObjectId(partyId, 'partyId');
    const settings = await getSettings();
    const self = via === 'pool_claim';
    try {
        return await withHoldingLock(async (session) => {
            const party = await Buyer.exists({ _id: partyId }).session(session);
            if (!party)
                throw new AppError({ code: 'NOT_FOUND', messageEn: 'Party not found.' });
            if (await Holding.exists({ partyId, isOpen: true }).session(session)) {
                throw refuse('Already claimed by someone else.');
            }
            if ((await ineligiblePartyIds([partyId], session)).size > 0) {
                throw refuse('This party cannot be taken.');
            }
            const holder = await Employee.findOne({ _id: holderId, active: true, positions: { $in: SALES_CALLER_POSITIONS } }, { person: 1 })
                .session(session)
                .lean();
            if (!holder) {
                throw refuse(self
                    ? 'Only a Sales Executive or Sr. Sales Executive can claim a party.'
                    : 'Pick a Sales Executive or Sr. Sales Executive.');
            }
            const last = await Holding.findOne({ partyId, isOpen: false })
                .sort({ endedAt: -1 })
                .session(session)
                .lean();
            if (last && id(last.holderId) === holderId) {
                throw refuse(self
                    ? 'You held this party last, so another caller has to take him.'
                    : `${holder.person} held this party last — pick someone else.`);
            }
            const uncalled = (await uncalledByHolder([holderId], session)).get(holderId).length;
            if (uncalled >= settings.uncalledCap) {
                throw refuse(self
                    ? `You have ${uncalled} uncalled. Call them first.`
                    : `${holder.person} has ${uncalled} uncalled — pick someone else.`);
            }
            // A party that has billed before is an ordered party: he comes back as a claim.
            const ordered = (await billsFor(partyId, settings.goLiveDate)).length > 0;
            const holding = await openHolding({ partyId, holderId, kind: ordered ? 'claim' : 'lead', via }, session);
            return id(holding._id);
        });
    }
    catch (error) {
        if (isDuplicateKey(error))
            throw refuse('Already claimed by someone else.');
        throw error;
    }
}
export async function claimParty(partyId, actor) {
    await assertHoldingEnabled();
    const holdingId = await takeFromPool(partyId, actor.employeeId, 'pool_claim');
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'holding',
        entityId: holdingId,
        field: 'claim',
        newValue: { partyId },
        correlationId: actor.correlationId,
    });
    return { holdingId };
}
export async function assignFromPool(partyId, callerId, actor) {
    assertValidObjectId(callerId, 'callerId');
    const holdingId = await takeFromPool(partyId, callerId, 'desk_assign');
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'holding',
        entityId: holdingId,
        field: 'desk_assign',
        newValue: { partyId, callerId },
        correlationId: actor.correlationId,
    });
    return { holdingId };
}
// ---------------------------------------------------------------------------
// The reason window (§4.4)
// ---------------------------------------------------------------------------
/** Log, or change, why the holder is letting this party go. Allowed only while the window is open. */
export async function logReason(holdingId, reason, employeeId) {
    await assertHoldingEnabled();
    assertValidObjectId(holdingId, 'holdingId');
    if (!RELEASE_REASONS.includes(reason))
        throw refuse('Pick a reason from the list.', 'reason');
    const holding = await Holding.findById(holdingId);
    if (!holding)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Holding not found.' });
    if (id(holding.holderId) !== employeeId) {
        throw refuse('Only the person holding this party can give the reason.');
    }
    if (!holding.isOpen || !holding.windowOpenedAt) {
        throw refuse('The time to give a reason for this party has not started, or is over.');
    }
    holding.reason = reason;
    holding.reasonAt = new Date();
    await holding.save();
}
// ---------------------------------------------------------------------------
// Closing a holding — release, convert, transfer (used by the nightly job)
// ---------------------------------------------------------------------------
/** Ends the holding and sends the party to the Pool. No reason logged = "owner did not diagnose". */
export async function releaseHolding(holdingId, now) {
    return withTransaction(async (session) => {
        const holding = await Holding.findOne({ _id: holdingId, isOpen: true }).session(session);
        if (!holding)
            return false;
        const closed = await Holding.updateOne({ _id: holdingId, isOpen: true }, { $set: { isOpen: false, endedAt: now, end: 'released', systemMarked: !holding.reason } }, { session });
        if (closed.modifiedCount === 0)
            return false;
        await dropMirror(id(holding.partyId), session);
        return true;
    });
}
/**
 * A lead (first bill) or a claim (a restart) turns into a book for the same
 * holder, starting on the bill's date. Close first, then open.
 */
export async function convertHolding(holdingId, end, bookStart, now) {
    return withTransaction(async (session) => {
        const holding = await Holding.findOne({ _id: holdingId, isOpen: true }).session(session);
        if (!holding)
            return false;
        const closed = await Holding.updateOne({ _id: holdingId, isOpen: true }, { $set: { isOpen: false, endedAt: now, end } }, { session });
        if (closed.modifiedCount === 0)
            return false;
        await openHolding({
            partyId: id(holding.partyId),
            holderId: id(holding.holderId),
            kind: 'book',
            via: 'conversion',
            startedAt: bookStart,
        }, session);
        return true;
    });
}
/**
 * §4.9 — a holding that exists on the go-live date. A party with bills is a book, one without is
 * a lead; neither counts as uncalled. A book already 90 days or more past its clock start on
 * go-live is backlog: the nightly job opens its window in turn, not all at once.
 */
export async function openGoLiveHolding(partyId, holderId, settings, bills) {
    if (!settings.goLiveDate)
        throw refuse('Set the go-live date first.');
    const goLive = istMidnight(settings.goLiveDate);
    const start = clockStart(bills, settings.billingThresholdPaise);
    const book = bills.length > 0 && start !== null;
    await withTransaction(async (session) => {
        await openHolding({
            partyId,
            holderId,
            kind: book ? 'book' : 'lead',
            via: 'go_live',
            startedAt: goLive,
            backlog: book && daysBetween(start, goLive) >= settings.orderedDays,
        }, session);
    });
}
/** Deactivating a caller: what he holds goes to the person taking over (same transaction as the book rows). */
export async function transferHoldings(fromEmployeeId, toEmployeeId, session) {
    await Holding.updateMany({ holderId: fromEmployeeId, isOpen: true }, { $set: { holderId: toEmployeeId, via: 'transfer' } }, { session });
}
