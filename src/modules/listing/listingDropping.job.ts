import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Listing } from '../../models/Listing.js';
import { addDays } from '../../shared/clock.js';
import {
  counterpartyIdForSeller,
  enqueueNotification,
} from '../notification/notification.outbox.js';

// BR-108 — "One reminder fires shortly before it drops." Seven days is the
// window the M8 brief names; the Charter says only "shortly before".
export const DROP_REMINDER_DAYS = 7;

/**
 * Daily, in the worker process (WORKFLOWS.md §3). The second of the two
 * scheduled jobs M8 adds (Step 0b).
 *
 * Finds live listings whose 45-day drop (`expiresAt`, BR-108) is within seven
 * days and sends `listing_dropping` **once per listing**: the claim sets
 * `dropReminderSentAt`, and the query excludes any listing that already has it,
 * so tomorrow's run finds nothing to do for the same listing. `relistListing`
 * clears the field, because a relisted listing starts a fresh 45 days.
 *
 * Each listing is claimed and notified in one transaction (TD-004). A listing
 * whose drop has already passed is not reminded — the reminder is about
 * something still ahead. This job never drops or pauses anything; that stays a
 * separate manual action, exactly as before.
 */
export async function runListingDropping(now: Date = new Date()): Promise<{ reminded: number }> {
  let reminded = 0;
  for (;;) {
    const didOne = await withTransaction(async (session) => {
      const listing = await Listing.findOneAndUpdate(
        {
          state: 'live',
          dropReminderSentAt: null,
          expiresAt: { $gt: now, $lte: addDays(now, DROP_REMINDER_DAYS) },
        },
        { $set: { dropReminderSentAt: now } },
        { session, new: true, sort: { expiresAt: 1 } },
      );
      if (!listing) return false;

      await enqueueNotification(
        {
          counterpartyId: await counterpartyIdForSeller(
            listing.sellerId as Types.ObjectId,
            session,
          ),
          templateKey: 'listing_dropping',
          params: {
            listingId: (listing._id as Types.ObjectId).toString(),
            dropsOn: listing.expiresAt.toISOString().slice(0, 10),
          },
        },
        session,
      );
      return true;
    });
    if (!didOne) break;
    reminded += 1;
  }
  return { reminded };
}
