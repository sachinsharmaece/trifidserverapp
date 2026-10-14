import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Po } from '../../models/Po.js';
import { So } from '../../models/So.js';
import { Counterparty } from '../../models/Counterparty.js';
import { FailureEvent } from '../../models/FailureEvent.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
const RATE_VIEW_DESK_CALL_THRESHOLD = 25; // BR-130.
const GRACE_BASE = 1; // BR-210 — 1 + 3% of trailing twelve-month commitments, rounded down.
const GRACE_RATE = 0.03;
const STRIKES_TO_BLACKLIST = 3; // BR-213.
const STRIKE_DECAY_MONTHS = 6; // BR-213.
const TRAILING_MONTHS = 12; // BR-211.
function monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d;
}
/** BR-214 — the denominator is commitments, not attempts. */
async function countTrailingCommitments(counterpartyId, kind) {
    if (kind === 'buyer') {
        const buyer = await Buyer.findOne({ counterpartyId });
        if (!buyer)
            return 0;
        return So.countDocuments({
            buyerId: buyer._id,
            createdAt: { $gte: monthsAgo(TRAILING_MONTHS) },
        });
    }
    const seller = await Seller.findOne({ counterpartyId });
    if (!seller)
        return 0;
    return Po.countDocuments({
        sellerId: seller._id,
        createdAt: { $gte: monthsAgo(TRAILING_MONTHS) },
    });
}
/** BR-210 — grace allowance, rounded down, no minimum-transaction floor and no cliff. */
function graceAllowance(trailingCommitments) {
    return GRACE_BASE + Math.floor(trailingCommitments * GRACE_RATE);
}
async function countActiveStrikes(counterpartyId) {
    return FailureEvent.countDocuments({
        counterpartyId,
        stage: 'strike',
        $or: [{ decaysAt: null }, { decaysAt: { $gt: new Date() } }],
    });
}
/**
 * How many of this counterparty's trailing-window failures have already
 * been absorbed by the grace allowance (BR-212 — logged, nothing else
 * happens). Once this reaches the allowance, the *next* failure is the one
 * that goes beyond it — this must count `withinGrace: true` events, not
 * `false` ones, or the allowance never actually runs out.
 */
async function countFailuresWithinGraceInWindow(counterpartyId) {
    return FailureEvent.countDocuments({
        counterpartyId,
        at: { $gte: monthsAgo(TRAILING_MONTHS) },
        withinGrace: true,
    });
}
async function blacklistIfThresholdReached(counterpartyId, reason) {
    const strikes = await countActiveStrikes(counterpartyId);
    if (strikes < STRIKES_TO_BLACKLIST)
        return;
    await Counterparty.updateOne({ _id: counterpartyId, status: { $ne: 'blacklisted' } }, { $set: { status: 'blacklisted' } });
    await writeAuditLog({
        actorId: counterpartyId.toString(),
        actorType: 'system',
        entity: 'counterparty',
        entityId: counterpartyId,
        field: 'status',
        newValue: 'blacklisted',
        reason,
        correlationId: `conduct-blacklist-${counterpartyId.toString()}`,
    });
}
/**
 * BR-212 — a failure inside the grace allowance is logged and nothing else
 * happens. Beyond it, this session's own reading of BR-213's ladder is that
 * a fresh beyond-grace failure enters at `warning`; staff walk it forward
 * from there with `advanceConductStage` — there is no clock-table entry for
 * a cure-period duration, so nothing here times out on its own (`CH §9.3`'s
 * clock table lists no such duration; flagged in the session report rather
 * than invented). Fraud skips the ladder entirely.
 */
export async function recordFailure(input, 
// M10 — a scheduled clock (worker) records failures with no employee: `employeeId: null`
// is logged as a `system` actor. `session` lets the caller commit the failure with the
// state change that caused it.
actor, session) {
    const trailing = await countTrailingCommitments(input.counterpartyId, input.counterpartyKind);
    const allowance = graceAllowance(trailing);
    const usedSoFar = await countFailuresWithinGraceInWindow(input.counterpartyId);
    const withinGrace = !input.viaFraud && usedSoFar < allowance;
    const now = new Date();
    const stage = input.viaFraud ? 'strike' : withinGrace ? 'logged' : 'warning';
    // Decay is set only when the ladder actually reaches `strike` via
    // `advanceConductStage` (BR-213); a fraud strike never decays (BR-217).
    // Both paths leave it null here.
    const decaysAt = null;
    const [event] = await FailureEvent.create([
        {
            counterpartyId: input.counterpartyId,
            counterpartyKind: input.counterpartyKind,
            type: input.type,
            chainId: input.chainId ?? null,
            at: now,
            withinGrace,
            stage,
            viaFraud: input.viaFraud ?? false,
            decaysAt,
            advancedBy: actor.employeeId,
        },
    ], { session, ordered: true });
    if (!event)
        throw new Error('FailureEvent.create returned no document.');
    // A system actor has no employee id; the counterparty the failure is about stands in
    // for it in the audit row (the same convention `blacklistIfThresholdReached` uses).
    const auditActorId = actor.employeeId ?? input.counterpartyId;
    const auditActorType = actor.employeeId ? 'staff' : 'system';
    await writeAuditLog({
        actorId: auditActorId,
        actorType: auditActorType,
        entity: 'failure_event',
        entityId: event._id,
        field: 'create',
        newValue: { stage, withinGrace, type: input.type },
        correlationId: actor.correlationId,
    }, session);
    let blacklisted = false;
    if (input.viaFraud) {
        await Counterparty.updateOne({ _id: input.counterpartyId }, { $set: { status: 'blacklisted' } }, { session });
        await writeAuditLog({
            actorId: auditActorId,
            actorType: auditActorType,
            entity: 'counterparty',
            entityId: input.counterpartyId,
            field: 'status',
            newValue: 'blacklisted',
            reason: `Fraud (BR-217) — ${input.type}`,
            correlationId: actor.correlationId,
        }, session);
        blacklisted = true;
    }
    return { failureEventId: event._id.toString(), stage, blacklisted };
}
const NEXT_STAGE = {
    warning: 'cure_period',
    cure_period: 'strike',
    strike: 'appeal',
    appeal: 'revision',
};
/**
 * BR-213 — "staff may waive at any stage with a logged reason and a
 * checker." `checkerEmployeeId` is required here for exactly that reason;
 * this function does not itself verify the two are different people (that
 * belongs to whichever maker-checker middleware guards the route, matching
 * the existing `requireReauth` pattern elsewhere in this codebase).
 */
export async function advanceConductStage(failureEventId, toStage, reason, actor) {
    const event = await FailureEvent.findById(failureEventId);
    if (!event)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Conduct event not found.' });
    if (event.viaFraud) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Fraud sits outside the ladder — nothing to advance (BR-217).',
        });
    }
    const nextStage = toStage === 'waive' ? event.stage : toStage;
    if (toStage !== 'waive' && NEXT_STAGE[event.stage] !== toStage) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `Cannot move from "${event.stage}" to "${toStage}" — the ladder only moves one step at a time.`,
        });
    }
    event.stage = nextStage;
    event.reason = reason;
    event.advancedBy = actor.checkerEmployeeId;
    if (nextStage === 'strike' && !event.decaysAt) {
        const decay = new Date();
        decay.setMonth(decay.getMonth() + STRIKE_DECAY_MONTHS);
        event.decaysAt = decay;
    }
    await event.save();
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'failure_event',
        entityId: event._id,
        field: 'stage',
        newValue: {
            stage: nextStage,
            waived: toStage === 'waive',
            checkerEmployeeId: actor.checkerEmployeeId,
        },
        reason,
        correlationId: actor.correlationId,
    });
    let blacklisted = false;
    if (nextStage === 'strike') {
        const before = await Counterparty.findById(event.counterpartyId);
        await blacklistIfThresholdReached(event.counterpartyId, `Third active strike (BR-213) — ${event.type}`);
        const after = await Counterparty.findById(event.counterpartyId);
        blacklisted = before?.status !== 'blacklisted' && after?.status === 'blacklisted';
    }
    return { stage: nextStage, blacklisted };
}
/** BR-218 — the disagree button. Sets the dispute flag; QR-025 leaves routing at one general queue. */
export async function disagreeWithFailureEvent(counterpartyId, failureEventId, reason, correlationId) {
    const event = await FailureEvent.findOne({ _id: failureEventId, counterpartyId });
    if (!event)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Conduct event not found.' });
    event.disputed = true;
    await event.save();
    await writeAuditLog({
        actorId: counterpartyId,
        actorType: 'counterparty',
        entity: 'failure_event',
        entityId: event._id,
        field: 'disputed',
        reason,
        correlationId,
    });
    return { recorded: true };
}
/** QR-025 — one general queue, visible to Controller. No SLA timer, no per-role routing yet. */
export async function getGeneralDisagreementQueue() {
    const events = await FailureEvent.find({ disputed: true }).sort({ at: -1 });
    return events.map((e) => ({
        failureEventId: e._id.toString(),
        counterpartyId: e.counterpartyId.toString(),
        counterpartyKind: e.counterpartyKind,
        type: e.type,
        stage: e.stage,
        at: e.at.toISOString(),
    }));
}
/** API-110 GET. */
export async function getBuyerConduct(buyerCounterpartyId) {
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    if (!buyer)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
    const counterparty = await Counterparty.findById(buyerCounterpartyId);
    const strikeCount = await countActiveStrikes(buyerCounterpartyId);
    const trailing = await countTrailingCommitments(buyerCounterpartyId, 'buyer');
    const allowance = graceAllowance(trailing);
    const usedWithinGrace = await countFailuresWithinGraceInWindow(buyerCounterpartyId);
    return {
        rateViews: buyer.rateViews,
        rateViewThreshold: RATE_VIEW_DESK_CALL_THRESHOLD,
        strikeCount,
        graceRemaining: Math.max(allowance - usedWithinGrace, 0),
        blacklisted: counterparty?.status === 'blacklisted',
    };
}
/**
 * API-110 POST disagree. Kept on `conductRefId` (now a `failureEventId`) for
 * route-shape compatibility with the earlier M5 build.
 */
export async function disagreeWithConduct(buyerCounterpartyId, conductRefId, reason, correlationId) {
    return disagreeWithFailureEvent(buyerCounterpartyId, conductRefId, reason, correlationId);
}
/** API-111. Real aggregates only — no fabricated grade or star rating. */
export async function getSellerScorecard(sellerCounterpartyId) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    if (!seller)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    const counterparty = await Counterparty.findById(sellerCounterpartyId);
    const pos = await Po.find({ sellerId: seller._id });
    const strikeCount = await countActiveStrikes(sellerCounterpartyId);
    const trailing = await countTrailingCommitments(sellerCounterpartyId, 'seller');
    const allowance = graceAllowance(trailing);
    const usedWithinGrace = await countFailuresWithinGraceInWindow(sellerCounterpartyId);
    return {
        trustTier: seller.trustTier,
        suppliesCompleted: seller.suppliesCompleted,
        poCount: pos.length,
        failedCount: pos.filter((p) => p.failed).length,
        requoteTotal: pos.reduce((sum, p) => sum + p.requoteCount, 0),
        strikeCount,
        graceRemaining: Math.max(allowance - usedWithinGrace, 0),
        blacklisted: counterparty?.status === 'blacklisted',
    };
}
export async function getConductHistory(counterpartyId) {
    const events = await FailureEvent.find({ counterpartyId }).sort({ at: -1 });
    return events.map((e) => ({
        failureEventId: e._id.toString(),
        type: e.type,
        stage: e.stage,
        withinGrace: e.withinGrace,
        disputed: e.disputed,
        at: e.at.toISOString(),
        decaysAt: e.decaysAt ? e.decaysAt.toISOString() : null,
    }));
}
