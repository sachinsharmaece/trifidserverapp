import { withTransaction } from '../../db/transaction.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { Seller } from '../../models/Seller.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { syncEnquiriesForPile } from '../enquiry/enquiry.sync.js';
import { offerPileRequests } from './pileOffer.service.js';
/**
 * WF-05's fan-out, run by the worker process 5 seconds after `demand.service.ts`'s `confirmPile`
 * schedules it (BR-137's deferred commit) — never run inline from the API request. **One
 * transaction**: every buyer on the pile is given his deal, or none is.
 *
 * 2 Nov — BR-378: it no longer makes the orders. Each buyer on the pile is *given the deal* — his
 * boxes, the expiry the seller fixed, his own rate — held for 24 hours (`pileOffer.service.ts`);
 * his order, with its own payment window and dispatch clock (BR-133), is made when he accepts it
 * (or when Sales does on his word). The boxes are taken off the listing now and go back if he
 * walks away or the hold runs out.
 *
 * This function is also called directly in tests, bypassing the scheduler, so the fan-out logic
 * itself is exercised without waiting on real time.
 */
export async function runConfirmPileFanout(pileId) {
    const pile = await Pile.findById(pileId);
    if (!pile)
        return; // Undone or already gone — nothing to do.
    if (pile.executedAt)
        return; // Already ran (defensive — should not happen).
    if (pile.decision !== 'confirmed')
        return; // Was requoted/declined/undone before this fired.
    const line = await ListingLine.findById(pile.listingLineId);
    if (!line)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });
    const listing = await Listing.findById(line.listingId);
    if (!listing)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
    const seller = await Seller.findById(listing.sellerId);
    if (!seller)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
    const requests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
    const totalAsked = requests.reduce((sum, r) => sum + r.qty, 0);
    const canSend = pile.confirmedQty ?? totalAsked;
    await withTransaction(async (session) => {
        // BR-134 — short pile: no automatic allocation rule exists. Flag it for
        // desk adjudication and stop here rather than guessing who gets how
        // much; the seller is never asked to choose between buyers.
        if (canSend < totalAsked) {
            pile.shortfall = true;
            pile.executedAt = new Date();
            await pile.save({ session });
            await syncEnquiriesForPile(pile._id, session); // DEC-051.
            return;
        }
        await offerPileRequests(requests.map((request) => ({ request, qty: request.qty })), session);
        // Held for the buyers while their 24 hours run; a deal walked away from gives its boxes back.
        line.qty = Math.max(0, line.qty - canSend);
        await line.save({ session });
        pile.executedAt = new Date();
        await pile.save({ session });
        await syncEnquiriesForPile(pile._id, session);
        await writeAuditLog({
            actorId: seller._id,
            actorType: 'counterparty',
            entity: 'pile',
            entityId: pile._id,
            field: 'executedAt',
            newValue: { buyerCount: requests.length, canSend, deals: 'given' },
            correlationId: `pile-${pileId}`,
        }, session);
    });
}
// Exported for the buyer-count check other services need without re-reading
// PileRequest directly.
export async function getPileBuyerCount(pileId) {
    return PileRequest.countDocuments({ pileId });
}
