import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Ask } from '../../models/Ask.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { enqueueNotification } from '../notification/notification.outbox.js';

/**
 * BR-122 — Trusted and Committed sellers see an ask four working hours before
 * everyone else. `Ask.visibleToAllAt` already holds the moment that head start
 * ends (computed at raise time by `computeVisibleToAllAt`, in IST working hours
 * — BR-231), and visibility is derived from it on every read. So "opening the
 * ask to the full board" needs no visibility change: what this job adds is the
 * recorded transition (`headStartOpenedAt`) and the `head_start_open` message.
 *
 * WORKFLOWS.md §3 — every 5 minutes, in the worker process. One of the two
 * scheduled jobs M8 adds (Step 0b); the other is `listingDropping.job.ts`.
 *
 * Each ask is claimed and notified in ONE transaction: the claim (an atomic
 * update that only one runner can win) and the outbox rows commit together, so
 * a crash can neither leave an ask marked open with no message queued nor
 * queue a message twice.
 *
 * `now` is a parameter so the working-hours boundary is testable.
 */
async function headStartSellerCounterpartyIds(
  session: import('mongoose').ClientSession,
): Promise<Types.ObjectId[]> {
  const sellers = await Seller.find({ trustTier: { $in: ['Trusted', 'Committed'] } }).session(
    session,
  );
  const counterparties = await Counterparty.find({
    _id: { $in: sellers.map((s) => s.counterpartyId) },
    status: 'active', // Never message a blacklisted or pending firm.
  }).session(session);
  return counterparties.map((c) => c._id as Types.ObjectId);
}

export async function runHeadStartOpen(now: Date = new Date()): Promise<{ opened: number }> {
  let opened = 0;
  for (;;) {
    const didOne = await withTransaction(async (session) => {
      const ask = await Ask.findOneAndUpdate(
        {
          state: { $in: ['open', 'quoted'] },
          headStartOpenedAt: null,
          visibleToAllAt: { $lte: now },
        },
        { $set: { headStartOpenedAt: now } },
        { session, new: true, sort: { visibleToAllAt: 1 } },
      );
      if (!ask) return false;

      // CH §21.8 #13 — "Inquiry seen four hours early", audience Seller: the
      // Trusted/Committed sellers who had the head start. See QR-052 — WF-09
      // step 2 reads as if they are told when the window OPENS, not when it closes.
      for (const counterpartyId of await headStartSellerCounterpartyIds(session)) {
        await enqueueNotification(
          {
            counterpartyId,
            templateKey: 'head_start_open',
            params: { askId: (ask._id as Types.ObjectId).toString() },
          },
          session,
        );
      }
      return true;
    });
    if (!didOne) break;
    opened += 1;
  }
  return { opened };
}
