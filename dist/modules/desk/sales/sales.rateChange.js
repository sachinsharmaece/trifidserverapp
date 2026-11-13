import { Ask } from '../../../models/Ask.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Employee } from '../../../models/Employee.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { Quote } from '../../../models/Quote.js';
import { Role } from '../../../models/Role.js';
import { OPEN_RATE_CHANGE_STATUSES, RateChangeRequest, } from '../../../models/RateChangeRequest.js';
import { PERMISSIONS } from '../../../config/permissions.js';
import { withTransaction } from '../../../db/transaction.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { formatRupees } from '../../../shared/money.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { isLeaderOf, leaderOf, teamOf } from '../../../shared/team.js';
import { computeBuyerFacingRatePaise } from '../../listing/listing.service.js';
import { notifyStaff } from '../../notice/notice.service.js';
const id = (value) => String(value);
/** What the order is raised for when Sales changes nothing — the boxes Confirm uses today. */
function defaultBoxes(quote, ask) {
    return Math.min(quote.qtyAvailable, ask.qty);
}
/** The Sales Leader who decides it; Admin when he is the leader himself, or has none. */
async function approverIdsFor(requestedBy) {
    const leader = await leaderOf('sales', requestedBy);
    if (leader && leader !== requestedBy && (await Employee.exists({ _id: leader, active: true }))) {
        return [leader];
    }
    const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
    if (!adminRole)
        return [];
    const admins = await Employee.find({ active: true, roleIds: adminRole._id, _id: { $ne: requestedBy } }, { _id: 1 });
    return admins.map((admin) => id(admin._id));
}
/**
 * Whether this caller may decide a request made by `requestedBy`: holds the permission, and is Admin
 * — who may decide any, **including their own** (product owner, 4 Nov: Admin has every right) — or
 * the Sales Leader of his team, who never decides his own.
 */
export async function mayDecideRateChange(caller, requestedBy) {
    if (!caller.permissions.includes(PERMISSIONS.SALES_APPROVE_RATE_CHANGE))
        return false;
    if (caller.permissions.includes(PERMISSIONS.BUYER_ADMIN))
        return true;
    if (caller.employeeId === requestedBy)
        return false;
    if (!(await isLeaderOf('sales', caller.employeeId)))
        return false;
    return (await teamOf('sales', caller.employeeId)).includes(requestedBy);
}
/** Whether what the request is about — the quote, or the pile deal — is still held for him. */
async function isTargetHeld(request) {
    if (request.pileRequestId) {
        const deal = await PileRequest.findById(request.pileRequestId, { offerState: 1, holdUntil: 1 });
        return !!deal && isDealHeld(deal);
    }
    const quote = await Quote.findById(request.quoteId, { status: 1, bindingUntil: 1 });
    return !!quote && quote.status === 'live' && quote.bindingUntil.getTime() > Date.now();
}
async function loadRequest(requestId) {
    assertValidObjectId(requestId, 'requestId');
    const request = await RateChangeRequest.findById(requestId);
    if (!request)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Request not found.' });
    return request;
}
const NOT_HELD = 'His rate is no longer held, so it cannot be changed.';
export async function requestRateChange(quoteId, input, actor, callNote) {
    assertValidObjectId(quoteId, 'quoteId');
    const quote = await Quote.findById(quoteId);
    if (!quote)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Quote not found.' });
    const ask = await Ask.findById(quote.askId);
    if (!ask)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
    if (quote.status !== 'live' ||
        quote.bindingUntil.getTime() <= Date.now() ||
        (ask.state !== 'open' && ask.state !== 'quoted')) {
        throw new AppError({ code: 'ENQUIRY_NOT_OPEN', messageEn: NOT_HELD });
    }
    const buyer = await Buyer.findById(ask.buyerId);
    const skuId = quote.skuId ?? ask.skuId;
    if (!buyer || !skuId) {
        throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'This rate has no pack to price.' });
    }
    const shownRatePaise = await computeBuyerFacingRatePaise(buyer, skuId, quote.ratePaiseForIndore);
    if (shownRatePaise === null) {
        throw new AppError({
            code: 'MARGIN_CELL_MISSING',
            messageEn: 'There is no margin set for this buyer’s tier on this pack yet.',
        });
    }
    return createRequest({
        ref: { quoteId: quote._id, askId: ask._id },
        openFilter: { quoteId: quote._id },
        buyer,
        shownRatePaise,
        maxBoxes: defaultBoxes(quote, ask),
        floorPaise: quote.ratePaiseForIndore,
    }, input, actor, callNote);
}
const NO_MARGIN = 'There is no margin set for this buyer’s tier on this pack yet.';
/**
 * 4 Nov — the same for a deal the seller confirmed for him (BR-378): the boxes he was given, and his
 * rate from the listing line. Its boxes are held off the listing, so the order may take fewer (the
 * rest go back, `acceptPileOffer`) but never more.
 */
export async function requestPileOfferChange(pileRequestId, input, actor, callNote) {
    assertValidObjectId(pileRequestId, 'pileRequestId');
    const deal = await PileRequest.findById(pileRequestId);
    if (!deal)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Deal not found.' });
    if (!isDealHeld(deal))
        throw new AppError({ code: 'ENQUIRY_NOT_OPEN', messageEn: NOT_HELD });
    const pile = await Pile.findById(deal.pileId);
    const line = pile ? await ListingLine.findById(pile.listingLineId) : null;
    const buyer = await Buyer.findById(deal.buyerId);
    if (!line || !buyer)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Deal not found.' });
    const shownRatePaise = await computeBuyerFacingRatePaise(buyer, line.skuId, line.ratePaise);
    if (shownRatePaise === null) {
        throw new AppError({ code: 'MARGIN_CELL_MISSING', messageEn: NO_MARGIN });
    }
    return createRequest({
        ref: { pileRequestId: deal._id },
        openFilter: { pileRequestId: deal._id },
        buyer,
        shownRatePaise,
        maxBoxes: deal.offerQty ?? deal.qty,
        floorPaise: line.ratePaise,
    }, input, actor, callNote);
}
/** A deal still waiting on his word, inside its 24-hour hold. */
function isDealHeld(deal) {
    return deal.offerState === 'offered' && !!deal.holdUntil && deal.holdUntil.getTime() > Date.now();
}
async function createRequest(target, input, actor, callNote) {
    const { buyer, shownRatePaise, maxBoxes } = target;
    if (await RateChangeRequest.exists({
        ...target.openFilter,
        status: { $in: OPEN_RATE_CHANGE_STATUSES },
    })) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'A change is already open on this rate — withdraw it before asking for another.',
        });
    }
    if (!Number.isInteger(input.boxes) || input.boxes < 1 || input.boxes > maxBoxes) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `Boxes must be a whole number from 1 to ${maxBoxes}.`,
            field: 'boxes',
        });
    }
    // BR-021 — never below the floor. The message does not say where it is: Sales never sees the
    // seller's net (BR-060). The same comparison `createSo` makes when the order is raised.
    if (!Number.isInteger(input.ratePaise) || input.ratePaise < target.floorPaise) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'That rate is too low to order at.',
            field: 'ratePaise',
        });
    }
    const rateChanged = input.ratePaise !== shownRatePaise;
    if (rateChanged && !input.reasonCode) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Pick why the rate changes (BR-048).',
            field: 'reasonCode',
        });
    }
    if (!rateChanged && input.boxes === maxBoxes) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Nothing is different from what he was shown — just Confirm.',
        });
    }
    const [approvers, counterparty, requester] = await Promise.all([
        approverIdsFor(actor.employeeId),
        Counterparty.findById(buyer.counterpartyId, { firm: 1 }),
        Employee.findById(actor.employeeId, { person: 1 }),
    ]);
    const requestId = await withTransaction(async (session) => {
        const [created] = await RateChangeRequest.create([
            {
                ...target.ref,
                buyerId: buyer._id,
                shownRatePaise,
                boxes: input.boxes,
                ratePaise: input.ratePaise,
                reasonCode: rateChanged ? (input.reasonCode ?? null) : null,
                callNote,
                requestedBy: actor.employeeId,
            },
        ], { session, ordered: true });
        if (!created)
            throw new Error('RateChangeRequest.create returned no document.');
        await notifyStaff(approvers, {
            kind: 'rate_change_requested',
            title: `Rate change to approve: ${counterparty?.firm ?? 'a buyer'}`,
            body: `${requester?.person ?? 'Sales'} asks to confirm ${input.boxes} boxes at ` +
                `₹${formatRupees(input.ratePaise)} instead of ${maxBoxes} at ₹${formatRupees(shownRatePaise)}` +
                ` — "${callNote}"`,
            link: `/sales/buyers/${id(buyer._id)}`,
        }, session);
        await writeAuditLog({
            actorId: actor.employeeId,
            actorType: 'staff',
            entity: 'rate_change_request',
            entityId: created._id,
            field: 'status',
            newValue: {
                status: 'pending',
                ...Object.fromEntries(Object.entries(target.ref).map(([k, v]) => [k, id(v)])),
                boxes: input.boxes,
                ratePaise: input.ratePaise,
                shownRatePaise,
            },
            reason: callNote,
            correlationId: actor.correlationId,
        }, session);
        return id(created._id);
    });
    return { requestId };
}
/** The requester takes it back — or Admin does — before Confirm has used it. */
export async function withdrawRateChange(requestId, caller) {
    const request = await loadRequest(requestId);
    if (id(request.requestedBy) !== caller.employeeId &&
        !caller.permissions.includes(PERMISSIONS.BUYER_ADMIN)) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: 'Only the person who asked can withdraw it.',
        });
    }
    const updated = await RateChangeRequest.findOneAndUpdate({ _id: request._id, status: { $in: OPEN_RATE_CHANGE_STATUSES } }, { $set: { status: 'withdrawn' } });
    if (!updated) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'It is no longer open — there is nothing to withdraw.',
        });
    }
    await writeAuditLog({
        actorId: caller.employeeId,
        actorType: 'staff',
        entity: 'rate_change_request',
        entityId: request._id,
        field: 'status',
        oldValue: updated.status,
        newValue: 'withdrawn',
        correlationId: caller.correlationId,
    });
    return { withdrawn: true };
}
export async function decideRateChange(requestId, input, caller) {
    const request = await loadRequest(requestId);
    if (request.status !== 'pending') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This has already been decided, or taken back.',
        });
    }
    if (!(await mayDecideRateChange(caller, id(request.requestedBy)))) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: id(request.requestedBy) === caller.employeeId
                ? 'You cannot approve your own request.'
                : 'This goes to the Sales Leader of the person who asked, or to Admin.',
        });
    }
    // The hold is not extended while a request waits: once the rate is gone there is nothing to approve.
    if (!(await isTargetHeld(request))) {
        await RateChangeRequest.updateOne({ _id: request._id, status: 'pending' }, { $set: { status: 'lapsed' } });
        throw new AppError({
            code: 'ENQUIRY_NOT_OPEN',
            messageEn: 'His rate is no longer held, so there is nothing to approve.',
        });
    }
    const buyer = await Buyer.findById(request.buyerId, { counterpartyId: 1 });
    const counterparty = buyer
        ? await Counterparty.findById(buyer.counterpartyId, { firm: 1 })
        : null;
    const decider = await Employee.findById(caller.employeeId, { person: 1 });
    await withTransaction(async (session) => {
        const decided = await RateChangeRequest.findOneAndUpdate({ _id: request._id, status: 'pending' }, {
            $set: {
                status: input.decision,
                decidedBy: caller.employeeId,
                decidedAt: new Date(),
                decisionNote: input.note,
            },
        }, { session });
        if (!decided) {
            throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'This has just been decided.' });
        }
        const approved = input.decision === 'approved';
        await notifyStaff(
        // An Admin deciding their own request needs no notice to say so.
        id(request.requestedBy) === caller.employeeId ? [] : [request.requestedBy], {
            kind: approved ? 'rate_change_approved' : 'rate_change_rejected',
            title: `Rate change ${approved ? 'approved' : 'rejected'}: ${counterparty?.firm ?? 'a buyer'}`,
            body: approved
                ? `${decider?.person ?? 'Your leader'} approved ${request.boxes} boxes at ₹${formatRupees(request.ratePaise)} — Confirm it before his hold ends.${input.note ? ` "${input.note}"` : ''}`
                : `${decider?.person ?? 'Your leader'} did not approve it.${input.note ? ` "${input.note}"` : ''}`,
            link: buyer ? `/sales/buyers/${id(request.buyerId)}` : null,
        }, session);
        await writeAuditLog({
            actorId: caller.employeeId,
            actorType: 'staff',
            entity: 'rate_change_request',
            entityId: request._id,
            field: 'status',
            oldValue: 'pending',
            newValue: input.decision,
            reason: input.note || undefined,
            correlationId: caller.correlationId,
        }, session);
    });
    return { status: input.decision };
}
const NOT_USABLE = {
    pending: 'That change is still waiting for approval.',
    rejected: 'That change was rejected.',
    withdrawn: 'That change was taken back.',
    lapsed: 'That change lapsed with his hold.',
    used: 'That change has already been used.',
};
/**
 * Takes the approval for this one Confirm: approved → used, atomically, so it can be spent once. It
 * must be for this ask and cover exactly the one rate being confirmed.
 */
export async function claimApprovedRateChange(approvalId, ctx) {
    const request = await loadRequest(approvalId);
    if (id(request.askId) !== ctx.askId) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'That approval is not for this ask.' });
    }
    if (ctx.quoteIds.length !== 1 || ctx.quoteIds[0] !== id(request.quoteId)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'An approved change covers the one rate it was asked for.',
        });
    }
    return spendApproval(request);
}
/**
 * The same for the deal the seller confirmed for him (BR-378): the approval must be for this deal.
 */
export async function claimApprovedPileOfferChange(approvalId, pileRequestId) {
    const request = await loadRequest(approvalId);
    if (id(request.pileRequestId) !== pileRequestId) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'That approval is not for this deal.' });
    }
    return spendApproval(request);
}
async function spendApproval(request) {
    const claimed = await RateChangeRequest.findOneAndUpdate({ _id: request._id, status: 'approved' }, { $set: { status: 'used' } }, { new: true });
    if (!claimed) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: NOT_USABLE[request.status] ?? 'That change cannot be used.',
        });
    }
    const overridden = claimed.reasonCode && claimed.ratePaise !== claimed.shownRatePaise;
    return {
        requestId: id(claimed._id),
        boxes: claimed.boxes,
        staffId: id(claimed.requestedBy),
        ...(overridden
            ? { overrideRatePaise: claimed.ratePaise, overrideReasonCode: claimed.reasonCode }
            : {}),
    };
}
/** The order could not be raised — the approval goes back to being usable. */
export async function releaseRateChangeClaim(requestId) {
    await RateChangeRequest.updateOne({ _id: requestId, status: 'used', soId: null }, { $set: { status: 'approved' } });
}
export async function markRateChangeUsed(requestId, soId) {
    await RateChangeRequest.updateOne({ _id: requestId }, { $set: { soId } });
}
/**
 * The latest request on each quote — or pile deal — that is still waiting, approved, or was
 * rejected, keyed by the quote's or the deal's id.
 */
export async function rateChangesByTarget(targetIds, caller) {
    const result = new Map();
    if (targetIds.length === 0)
        return result;
    const rows = await RateChangeRequest.find({
        $or: [{ quoteId: { $in: targetIds } }, { pileRequestId: { $in: targetIds } }],
        status: { $in: ['pending', 'approved', 'rejected'] },
    }).sort({ createdAt: -1 });
    const targetOf = (row) => id(row.quoteId ?? row.pileRequestId);
    const latest = rows.filter((row, index) => rows.findIndex((other) => targetOf(other) === targetOf(row)) === index);
    const people = await Employee.find({
        _id: {
            $in: latest.flatMap((row) => [row.requestedBy, row.decidedBy].filter((v) => v != null)),
        },
    }, { person: 1 });
    const nameOf = new Map(people.map((p) => [id(p._id), p.person]));
    for (const row of latest) {
        result.set(targetOf(row), {
            requestId: id(row._id),
            status: row.status,
            boxes: row.boxes,
            ratePaise: row.ratePaise,
            shownRatePaise: row.shownRatePaise,
            reasonCode: row.reasonCode ?? null,
            callNote: row.callNote,
            requestedByName: nameOf.get(id(row.requestedBy)) ?? '—',
            requestedAt: row.createdAt.toISOString(),
            decidedByName: row.decidedBy ? (nameOf.get(id(row.decidedBy)) ?? null) : null,
            decisionNote: row.decisionNote ?? '',
            canDecide: row.status === 'pending' && caller
                ? await mayDecideRateChange(caller, id(row.requestedBy))
                : false,
            canWithdraw: row.status !== 'rejected' &&
                !!caller &&
                (id(row.requestedBy) === caller.employeeId ||
                    caller.permissions.includes(PERMISSIONS.BUYER_ADMIN)),
        });
    }
    return result;
}
