import { Config } from '../../models/Config.js';
import { AppError } from '../../shared/errors.js';
/**
 * RECTIFY-01 Phase 0 — the emergency brake. `config.marketplace_paused` ships off. While it is on the
 * server refuses what starts new trade: a new listing, a relist, a new quote, giving a parked quote,
 * a new pile request, a seller's pile confirm (which is what gives buyers a deal), a new pool
 * commitment, and taking a quote or a deal. Orders already raised, payments, dispatch, Marg, a new
 * ask, and a placement into a pool already committed to are not paused — those are trades already
 * made, or a buyer saying what he wants.
 *
 * Read the way `claim_board` is: a `Config` row whose value is the boolean `true`. A missing row
 * is off, so the flag costs nothing until someone turns it on.
 */
export const MARKETPLACE_PAUSED_MESSAGE = 'Trading is paused for a short while. The desk will call you.';
export async function isMarketplacePaused() {
    const config = await Config.findOne({ key: 'marketplace_paused' });
    return config?.value === true;
}
/**
 * The one guard, called at each entry point (listed in docs/rectify-01/PLAN_NOTES.md). Call it
 * before the first write of the function it protects, so a refused call leaves nothing behind.
 */
export async function assertMarketplaceOpen() {
    if (await isMarketplacePaused()) {
        throw new AppError({
            code: 'MARKETPLACE_PAUSED',
            messageEn: MARKETPLACE_PAUSED_MESSAGE,
            retryable: false,
        });
    }
}
export const STOPPED_BY_TRIFID_MESSAGE = 'TriFid has paused this listing. Call the purchase desk.';
/**
 * A listing TriFid stopped is lifted only by the staff restart. Whatever else a caller is doing on
 * it — relisting, confirming a pile — is refused while that holds, whether or not the brake is on.
 */
export function assertNotStoppedByStaff(listing) {
    if (listing.stoppedBy === 'staff') {
        throw new AppError({ code: 'VALIDATION_FAILED', messageEn: STOPPED_BY_TRIFID_MESSAGE });
    }
}
/**
 * RECTIFY-01 Phase 0 — `config.pile_requote_enabled`, ships off. Requote is being rebuilt: with the
 * flag off `requotePile` is refused, because it closes the pile and tells every buyer "accept or
 * cancel" with nothing for them to accept. Removed when the rebuild ships (RECTIFY-01_PLAN §3.1, §5).
 */
export async function isPileRequoteEnabled() {
    const config = await Config.findOne({ key: 'pile_requote_enabled' });
    return config?.value === true;
}
