import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { AppError } from '../../shared/errors.js';
import { createSoInSession } from '../chain/chain.service.js';
import { writeAuditLog } from '../../shared/audit.js';
import { syncEnquiriesForPile } from '../enquiry/enquiry.sync.js';
import {
  enqueueNotification,
  counterpartyIdForBuyer,
} from '../notification/notification.outbox.js';

/**
 * WF-05's actual fan-out, run by the worker process 5 seconds after
 * `demand.service.ts`'s `confirmPile` schedules it (BR-137's deferred
 * commit) — never run inline from the API request. **Nine steps, one
 * transaction**: every SO this creates, or none of them, per buyer on the
 * pile at the moment it was confirmed.
 *
 * This function is also called directly in tests, bypassing the scheduler,
 * so the fan-out logic itself is exercised without waiting on real time.
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
  const seller = await Seller.findById(listing.sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const sellerCounterparty = await Counterparty.findById(seller.counterpartyId);

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
      await syncEnquiriesForPile(pile._id as Types.ObjectId, session); // DEC-051.
      return;
    }

    const actor = {
      employeeId: sellerCounterparty
        ? (sellerCounterparty._id as Types.ObjectId).toString()
        : 'system',
      correlationId: `pile-${pileId}`,
    };

    for (const request of requests) {
      const { soNo } = await createSoInSession(
        {
          buyerId: (request.buyerId as Types.ObjectId).toString(),
          sellerId: (seller._id as Types.ObjectId).toString(),
          skuId: (line.skuId as Types.ObjectId).toString(),
          boxes: request.qty,
          sellerNetPaise: line.ratePaise,
          placeOfSupply: 'intra_state', // Refined once M6's tax-jurisdiction lookup exists; see CHANGELOG.
          pileRequestId: (request._id as Types.ObjectId).toString(),
          ...(request.enquiryId
            ? { enquiryId: (request.enquiryId as Types.ObjectId).toString() }
            : {}),
        },
        actor,
        session,
      );

      // WF-05 step 8 — "Write N notification outbox rows", inside this same transaction.
      // CH §21.8 #3 — "Seller confirms supply." Queued AFTER createSoInSession's own
      // `payment_due` for this buyer, so where the weekly cap (BR-283) allows only one
      // message it is the money deadline that goes out, not this one — see QR-054.
      await enqueueNotification(
        {
          counterpartyId: await counterpartyIdForBuyer(request.buyerId as Types.ObjectId, session),
          templateKey: 'order_confirmed',
          params: { soNo },
          correlationId: actor.correlationId,
        },
        session,
      );
    }

    line.qty = Math.max(0, line.qty - canSend);
    await line.save({ session });

    pile.executedAt = new Date();
    await pile.save({ session });
    // DEC-051 — every buyer's enquiry on this pile is now ordered, in this transaction.
    await syncEnquiriesForPile(pile._id as Types.ObjectId, session);

    await writeAuditLog(
      {
        actorId: seller._id as Types.ObjectId,
        actorType: 'counterparty',
        entity: 'pile',
        entityId: pile._id as Types.ObjectId,
        field: 'executedAt',
        newValue: { buyerCount: requests.length, canSend },
        correlationId: actor.correlationId,
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
