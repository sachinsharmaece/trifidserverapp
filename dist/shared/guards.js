import { Counterparty } from '../models/Counterparty.js';
import { AppError } from './errors.js';
/**
 * BR-213/QR-015 — three strikes blacklists a counterparty, but only blocks
 * *new* activity; nothing in flight is touched (chains, payouts and refunds
 * already running continue under ordinary rules). Call this at every entry
 * point that starts something new: a listing, a quote, an inquiry, a pool
 * join. Never call it on a read, and never call it inside a flow that is
 * continuing an already-existing commitment (payment, dispatch, inspection).
 */
export async function assertCounterpartyActive(counterpartyId) {
    const counterparty = await Counterparty.findById(counterpartyId);
    if (counterparty?.status === 'blacklisted') {
        throw new AppError({
            code: 'ACCOUNT_NOT_ACTIVE',
            messageEn: 'This account is blocked. Call the sales desk for help.',
        });
    }
}
/**
 * 1 Nov — only an approved buyer can be put on an offer, join a pool or have an ask raised: an
 * order is refused for anyone else (chain.service `createSoInSession`), so letting him in sent the
 * request through Purchase → Confirmations and then lost it when the order step refused. Stopped
 * here, at the start, with a message the desk can act on. A blacklisted account keeps its own
 * message (`assertCounterpartyActive`).
 */
export async function assertBuyerApproved(counterpartyId) {
    const counterparty = await Counterparty.findById(counterpartyId, { status: 1, firm: 1 });
    if (counterparty && counterparty.status !== 'active' && counterparty.status !== 'blacklisted') {
        throw new AppError({
            code: 'ACCOUNT_NOT_ACTIVE',
            messageEn: `${counterparty.firm ?? 'This buyer'} is not approved yet — approve him in Registrations first.`,
        });
    }
}
