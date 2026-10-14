import { Enquiry } from '../../models/Enquiry.js';
import { Ask } from '../../models/Ask.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { nextEnquiryNo } from '../chain/chain.numbering.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { deriveAskStatus, derivePileRequestStatus, } from './enquiry.status.js';
/**
 * Creates the enquiry for a just-created ask or pile request, with its first
 * status. 2026-10-02 — pivoting away from Enquiry for now (ENQUIRY_FLOW_ENABLED,
 * see config/env.ts); `null` when off, which every caller already treats as
 * "no enquiry" since `Ask.enquiryId`/`PileRequest.enquiryId` are nullable.
 */
export async function createTradeEnquiryInSession(input, status, session) {
    if (!env.enquiryFlowEnabled)
        return null;
    const [enquiry] = await Enquiry.create([
        {
            enquiryNo: await nextEnquiryNo(input.raisedAt, session),
            kind: input.kind,
            channel: input.channel,
            raisedAt: input.raisedAt,
            raisedBy: input.raisedBy ?? null,
            buyerId: input.buyerId,
            skuId: input.skuId ?? null,
            productId: input.productId ?? null,
            qty: input.qty,
            requirement: input.requirement ?? null,
            askId: input.askId ?? null,
            pileRequestId: input.pileRequestId ?? null,
            ...status,
            statusChangedAt: input.raisedAt,
        },
    ], { session, ordered: true });
    if (!enquiry)
        throw new Error('Enquiry.create returned no document.');
    return enquiry._id;
}
/**
 * DEC-052 — a pre-trade enquiry becomes the ask just raised for it: same
 * enquiry, same number, same owners, follow-ups and notes. What it was asked
 * as (prospect, free-text product) stays on the record as history.
 */
export async function convertPreTradeEnquiryInSession(enquiryId, input, status, now, session) {
    // 2026-10-02 — same pivot-away flag as createTradeEnquiryInSession. A
    // pre-trade enquiryId can only exist if the (now-unmounted) enquiry router
    // created one while the feature was on, so this is defensive, not the
    // primary guard.
    if (!env.enquiryFlowEnabled)
        return null;
    const enquiry = await Enquiry.findById(enquiryId).session(session);
    if (!enquiry)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Enquiry not found.' });
    if (enquiry.kind !== 'pre_trade' || enquiry.status !== 'pre_trade') {
        throw new AppError({
            code: 'ENQUIRY_NOT_OPEN',
            messageEn: 'Only an open pre-trade enquiry can be converted to an ask.',
        });
    }
    if (enquiry.buyerId && String(enquiry.buyerId) !== String(input.buyerId)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This enquiry belongs to a different buyer.',
            field: 'buyerCounterpartyId',
        });
    }
    await Enquiry.updateOne({ _id: enquiry._id }, {
        $set: {
            kind: 'ask',
            askId: input.askId,
            buyerId: input.buyerId,
            skuId: input.skuId ?? null,
            productId: input.productId ?? null,
            qty: input.qty,
            requirement: input.requirement ?? null,
            ...status,
            statusChangedAt: now,
        },
    }, { session });
    return enquiry._id;
}
async function writeStatus(enquiry, next, now, session) {
    if (enquiry.status === next.status &&
        enquiry.phase === next.phase &&
        enquiry.outcome === next.outcome &&
        (enquiry.waitingOn ?? null) === next.waitingOn) {
        return;
    }
    await Enquiry.updateOne({ _id: enquiry._id }, {
        $set: {
            ...next,
            statusChangedAt: now,
            closedAt: next.phase === 'closed' ? now : null,
        },
    }, { session });
}
/** Re-derives and stores the status of the enquiry that IS this ask. No-op for a pre-enquiry ask. */
export async function syncEnquiryForAsk(askId, session, now = new Date()) {
    if (!env.enquiryFlowEnabled)
        return;
    const enquiry = await Enquiry.findOne({ askId }).session(session);
    if (!enquiry)
        return;
    const ask = await Ask.findById(askId).session(session);
    if (!ask)
        return;
    await writeStatus(enquiry, deriveAskStatus({ state: ask.state, visibleToAllAt: ask.visibleToAllAt }, now), now, session);
}
/** One pile decision moves every buyer's enquiry on that pile — re-derive them all. */
export async function syncEnquiriesForPile(pileId, session, now = new Date()) {
    if (!env.enquiryFlowEnabled)
        return;
    const pile = await Pile.findById(pileId).session(session);
    if (!pile)
        return;
    const requestIds = (await PileRequest.find({ pileId }, { _id: 1 }).session(session)).map((r) => r._id);
    const enquiries = await Enquiry.find({ pileRequestId: { $in: requestIds } }).session(session);
    const next = derivePileRequestStatus({
        decision: (pile.decision ?? null),
        executedAt: pile.executedAt ?? null,
        shortfall: pile.shortfall,
    });
    for (const enquiry of enquiries)
        await writeStatus(enquiry, next, now, session);
}
