import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { So } from '../../models/So.js';
import { Po } from '../../models/Po.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { logger } from '../../shared/logger.js';
import { writeAuditLog } from '../../shared/audit.js';
import { addHours, istDateKey } from '../../shared/clock.js';
import { writeChainEvent } from '../chain/chain.events.js';
import {
  cancelUnpaidSo,
  closeDeliveredSo,
  resolveExpiredPromotionOffers,
  type CancelUnpaidOutcome,
} from '../chain/chain.service.js';
import { recordFailure } from '../conduct/conduct.service.js';

/**
 * M10 Step 0b — the four clocks a real pilot cannot run without. Each job only
 * FINDS overdue records and calls the ONE existing unit per record; none holds
 * a business rule of its own, so the manual action and the clock cannot drift
 * apart. Every job takes `now` so a test can advance the clock past a deadline.
 *
 * CH §25.2 — these run in the worker process (worker/index.ts), never in the web app.
 * A failure on one record is logged and does not stop the rest.
 */

function correlationFor(job: string, now: Date): string {
  return `clock-${job}-${now.toISOString()}`;
}

// ---------------------------------------------------------------------------
// 1. Payment-window expiry — BR-032 (24 h), BR-035. Pool orders (BR-156) are
//    deliberately skipped by `cancelUnpaidSo`; see QR-065.
// ---------------------------------------------------------------------------

export async function runPaymentWindowExpiry(
  now: Date = new Date(),
): Promise<Record<CancelUnpaidOutcome, number>> {
  const counts: Record<CancelUnpaidOutcome, number> = {
    cancelled: 0,
    not_due: 0,
    pool_order: 0,
    paid: 0,
    payment_declared: 0,
  };
  const overdue = await So.find({ state: 'awaiting_payment', payDeadline: { $lt: now } }).select(
    '_id',
  );
  for (const so of overdue) {
    const soId = (so._id as Types.ObjectId).toString();
    try {
      counts[await cancelUnpaidSo(soId, now, correlationFor('payment-expiry', now))] += 1;
    } catch (error) {
      logger.error({ msg: 'payment-window expiry failed for one order', soId, error });
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 2. Dispatch-clock chase — BR-174. The 48-hour line is the failure (BR-215);
//    the same-day miss is "pressure, not a failure" (BR-215's own words).
// ---------------------------------------------------------------------------

const DISPATCH_FAILURE_HOURS = 48; // BR-174 — the buyer's promise, and BR-215's failure line.

/**
 * The seller's same-day line: his dispatch cut-off time (BR-173, "HH:MM", IST) on the
 * IST day the PO released. A PO that released after his cut-off is read as due at his
 * cut-off the next day — the same reading BR-173 gives the delivery band. See QR-064.
 */
function sameDayDeadline(releasedAt: Date, cutoffHHMM: string): Date {
  const sameDay = new Date(`${istDateKey(releasedAt)}T${cutoffHHMM}:00+05:30`);
  if (releasedAt.getTime() < sameDay.getTime()) return sameDay;
  return addHours(sameDay, 24);
}

export type DispatchChaseOutcome = 'failure' | 'pressure' | 'none';

/** One PO, one transaction. A dispatch racing this conflicts on the PO and re-reads. */
export async function chasePoDispatchClock(
  poId: string,
  now: Date,
  correlationId: string,
): Promise<DispatchChaseOutcome> {
  return withTransaction(async (session): Promise<DispatchChaseOutcome> => {
    const po = await Po.findOne({ _id: poId, state: 'released' }).session(session);
    if (!po) return 'none'; // Already dispatched (or failed): nothing to chase.
    const seller = await Seller.findById(po.sellerId).session(session);
    if (!seller) return 'none';
    const sellerCounterpartyId = (seller.counterpartyId as Types.ObjectId).toString();
    const chainId = po.chainId as Types.ObjectId;

    // The 48-hour line counts from the (lifeline-extended) dispatch due date, BR-174 / BR-234.
    const failureLine = addHours(po.dispatchDueDate, DISPATCH_FAILURE_HOURS);
    if (now.getTime() > failureLine.getTime() && !po.noDispatch48hAt) {
      const claimed = await Po.findOneAndUpdate(
        { _id: po._id, state: 'released', noDispatch48hAt: null },
        { $set: { noDispatch48hAt: now, sameDayMissAt: po.sameDayMissAt ?? now } },
        { session },
      );
      if (!claimed) return 'none';
      // BR-215 — "no dispatch within 48 hours" is a counted seller failure (grace applies, BR-212).
      await recordFailure(
        {
          counterpartyId: sellerCounterpartyId,
          counterpartyKind: 'seller',
          type: 'seller_no_dispatch_48h',
          chainId: chainId.toString(),
        },
        { employeeId: null, correlationId },
        session,
      );
      await writeChainEvent(
        {
          chainId,
          type: 'dispatch_failure_48h',
          refCollection: 'po',
          refId: po._id as Types.ObjectId,
          actorId: sellerCounterpartyId,
          actorType: 'system',
          summary: `${po.poNo} — not dispatched within 48 hours; a seller conduct event was recorded (BR-174, BR-215).`,
        },
        session,
      );
      return 'failure';
    }

    const sameDayLine = sameDayDeadline(po.dispatchDueDate, seller.dispatchCutoffTime);
    if (now.getTime() > sameDayLine.getTime() && !po.sameDayMissAt) {
      const claimed = await Po.findOneAndUpdate(
        { _id: po._id, state: 'released', sameDayMissAt: null },
        { $set: { sameDayMissAt: now } },
        { session },
      );
      if (!claimed) return 'none';
      // BR-215 — pressure, not a failure: no conduct event, only a mark on the chain.
      await writeChainEvent(
        {
          chainId,
          type: 'dispatch_overdue_same_day',
          refCollection: 'po',
          refId: po._id as Types.ObjectId,
          actorId: sellerCounterpartyId,
          actorType: 'system',
          summary: `${po.poNo} — not dispatched by the seller's same-day cut-off. Pressure only; the 48-hour line is the failure (BR-174, BR-215).`,
        },
        session,
      );
      await writeAuditLog(
        {
          actorId: sellerCounterpartyId,
          actorType: 'system',
          entity: 'po',
          entityId: po._id as Types.ObjectId,
          field: 'sameDayMissAt',
          newValue: now.toISOString(),
          correlationId,
        },
        session,
      );
      return 'pressure';
    }
    return 'none';
  });
}

export async function runDispatchChase(
  now: Date = new Date(),
): Promise<Record<DispatchChaseOutcome, number>> {
  const counts: Record<DispatchChaseOutcome, number> = { failure: 0, pressure: 0, none: 0 };
  const candidates = await Po.find({
    state: 'released',
    dispatchDueDate: { $lt: now },
    $or: [{ noDispatch48hAt: null }, { sameDayMissAt: null }],
  }).select('_id');
  for (const po of candidates) {
    const poId = (po._id as Types.ObjectId).toString();
    try {
      counts[await chasePoDispatchClock(poId, now, correlationFor('dispatch-chase', now))] += 1;
    } catch (error) {
      logger.error({ msg: 'dispatch chase failed for one PO', poId, error });
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 3. Promotion-offer expiry — WF-11, 24 h. Silence is the buyer's decline with
//    no button pressed: `resolveExpiredPromotionOffers` calls the very function
//    `rejectPromotionOffer` calls.
// ---------------------------------------------------------------------------

export async function runPromotionOfferExpiry(now: Date = new Date()): Promise<number> {
  return resolveExpiredPromotionOffers(now);
}

// ---------------------------------------------------------------------------
// 4. Seven-day delivery auto-close — BR-192. Silence is delivery: the same
//    close `confirm-receipt` performs, via `closeDeliveredSo`.
// ---------------------------------------------------------------------------

export async function runDeliveryAutoClose(now: Date = new Date()): Promise<{ closed: number }> {
  let closed = 0;
  const due = await So.find({
    state: 'dispatched_leg2',
    deliveryWindowEndsAt: { $lt: now },
  }).select('_id buyerId');
  for (const so of due) {
    const soId = (so._id as Types.ObjectId).toString();
    try {
      const buyer = await Buyer.findById(so.buyerId).select('counterpartyId');
      if (!buyer) continue;
      const didClose = await closeDeliveredSo(
        soId,
        { actorId: (buyer.counterpartyId as Types.ObjectId).toString(), actorType: 'system' },
        correlationFor('delivery-auto-close', now),
        { deliveryWindowEndsAt: { $lt: now } },
      );
      if (didClose) closed += 1;
    } catch (error) {
      logger.error({ msg: 'delivery auto-close failed for one order', soId, error });
    }
  }
  return { closed };
}
