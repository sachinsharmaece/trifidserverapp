import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { Seller } from '../../models/Seller.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { syncEnquiriesForPile } from '../enquiry/enquiry.sync.js';
import {
  declineConfirmedPileOfStoppedListing,
  type StopContext,
} from '../marketplace/marketplace.closure.js';
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
 *
 * It can be reached twice for one pile: by the scheduled job above and, if that one failed, by the
 * recovery job (`pileRecovery.job.ts`). It is safe to run more than once — the pile is claimed with
 * one atomic update first, and only the runner that wins it goes on — so a buyer is never given his
 * deal, or messaged, twice. The claim is a single update, not a document save, so an unrelated
 * sub-document on the pile (its `proxyLog`) can no longer fail the whole fan-out on validation.
 */
export async function runConfirmPileFanout(pileId: string): Promise<void> {
  const pile = await Pile.findById(pileId);
  if (!pile) return; // Undone or already gone — nothing to do.
  if (pile.executedAt) return; // Already ran (defensive — should not happen).
  if (pile.decision !== 'confirmed') return; // Was requoted/declined/undone before this fired.

  const line = await ListingLine.findById(pile.listingLineId);
  if (!line) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });
  const listing = await Listing.findById(line.listingId);
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });

  // RECTIFY-01 — staff stopped this listing after the seller confirmed and before the buyers were given
  // their deal. They get no deal at the rate TriFid stopped: the pile closes as a desk decline (no
  // strike, no message to the buyers) and Sales is told whom to ring. Deals already offered are left
  // alone; this pile has none yet.
  if (listing.stoppedBy === 'staff') {
    const ctx: StopContext = {
      employeeId: String(listing.stoppedByEmployeeId ?? listing.sellerId),
      correlationId: `pile-${pileId}`,
      reasonCode: listing.stopReasonCode ?? 'other',
      note: listing.stopNote ?? '',
      stopBatchId: listing.stopBatchId ?? null,
      now: new Date(),
    };
    await withTransaction((session) =>
      declineConfirmedPileOfStoppedListing(
        pile._id as Types.ObjectId,
        listing.productId,
        ctx,
        session,
      ),
    );
    return;
  }

  const seller = await Seller.findById(listing.sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });

  const requests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
  const totalAsked = requests.reduce((sum, r) => sum + r.qty, 0);
  const canSend = pile.confirmedQty ?? totalAsked;
  const short = canSend < totalAsked;
  // Taken before the transaction so a retry of it subtracts from the same starting figure.
  const lineQtyBefore = line.qty;

  await withTransaction(async (session) => {
    const claimed = await Pile.findOneAndUpdate(
      { _id: pile._id, decision: 'confirmed', executedAt: null },
      { $set: { executedAt: new Date(), ...(short ? { shortfall: true } : {}) } },
      { session },
    );
    if (!claimed) return; // Another runner got here first — nothing left to do.

    // BR-134 — short pile: no automatic allocation rule exists. Flagged above for
    // desk adjudication; stop here rather than guessing who gets how
    // much; the seller is never asked to choose between buyers.
    if (short) {
      await syncEnquiriesForPile(pile._id as Types.ObjectId, session); // DEC-051.
      return;
    }

    await offerPileRequests(
      requests.map((request) => ({ request, qty: request.qty })),
      session,
    );

    // Held for the buyers while their 24 hours run; a deal walked away from gives its boxes back.
    line.qty = Math.max(0, lineQtyBefore - canSend);
    await line.save({ session });

    await syncEnquiriesForPile(pile._id as Types.ObjectId, session);

    await writeAuditLog(
      {
        actorId: seller._id as Types.ObjectId,
        actorType: 'counterparty',
        entity: 'pile',
        entityId: pile._id as Types.ObjectId,
        field: 'executedAt',
        newValue: { buyerCount: requests.length, canSend, deals: 'given' },
        correlationId: `pile-${pileId}`,
      },
      session,
    );
  });
}

// Exported for the buyer-count check other services need without re-reading
// PileRequest directly.
export async function getPileBuyerCount(pileId: string): Promise<number> {
  return PileRequest.countDocuments({ pileId });
}
