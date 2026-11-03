import type { Types } from 'mongoose';
import { Pile } from '../../models/Pile.js';

/**
 * 2 Nov — whether a listing line can take another request, and if not why (BR-133, BR-136).
 *
 * A line's requests pile up into a group the seller decides once (BR-133). A decided group does
 * not close the line for good: BR-136 accepts sequential piles, a split fill on a slower clock,
 * so once a confirmed group has had its orders made the next request opens a new group — while
 * stock remains. The line stays closed only while something is still in flight, or the seller
 * said no.
 */
export type LineClosed = 'confirmed' | 'short' | 'requoted' | 'declined' | 'sold_out' | null;

interface GroupFacts {
  decision: 'confirmed' | 'requoted' | 'declined' | null;
  executedAt: Date | null;
  shortfall: boolean;
  shortfallResolved: boolean;
  openedAt: Date;
}

/**
 * `null` = it takes requests (an open group, or the next one can open). Otherwise why not:
 *  - `confirmed` — the seller confirmed it and its orders are not made yet;
 *  - `short` — the seller can send fewer boxes than were asked and the desk has still to say who
 *    gets them (BR-134);
 *  - `requoted` — the seller revised it and the buyers have yet to accept or cancel;
 *  - `declined` — the seller turned it down;
 *  - `sold_out` — it was filled and no stock is left.
 */
export function closedStateOf(line: { qty: number }, groups: GroupFacts[]): LineClosed {
  if (groups.some((g) => !g.decision)) return null; // An open group takes more.
  const latest = [...groups].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
  if (!latest) return null; // Never piled: nothing has been decided.
  if (latest.decision === 'requoted') return 'requoted';
  if (latest.decision === 'declined') return 'declined';
  // Confirmed. In flight until the fan-out has run, and while a short pile awaits the desk.
  if (!latest.executedAt) return 'confirmed';
  if (latest.shortfall && !latest.shortfallResolved) return 'short';
  return line.qty >= 1 ? null : 'sold_out';
}

/** A stored group, as the rule reads it. */
export function groupFacts(pile: {
  decision?: string | null;
  executedAt?: Date | null;
  shortfall?: boolean | null;
  shortfallResolvedAt?: Date | null;
  openedAt: Date;
}): GroupFacts {
  return {
    decision: (pile.decision ?? null) as GroupFacts['decision'],
    executedAt: pile.executedAt ?? null,
    shortfall: Boolean(pile.shortfall),
    shortfallResolved: Boolean(pile.shortfallResolvedAt),
    openedAt: pile.openedAt,
  };
}

/** The state for many lines at once: one read, however long the board is. */
export async function closedStateByLine(
  lines: Array<{ _id: unknown; qty: number }>,
): Promise<Map<string, LineClosed>> {
  const result = new Map<string, LineClosed>();
  if (lines.length === 0) return result;
  const piles = await Pile.find(
    { listingLineId: { $in: lines.map((l) => l._id) } },
    {
      listingLineId: 1,
      decision: 1,
      executedAt: 1,
      shortfall: 1,
      shortfallResolvedAt: 1,
      openedAt: 1,
    },
  );
  const byLine = new Map<string, GroupFacts[]>();
  for (const pile of piles) {
    const key = (pile.listingLineId as Types.ObjectId).toString();
    byLine.set(key, [...(byLine.get(key) ?? []), groupFacts(pile)]);
  }
  for (const line of lines) {
    const key = String(line._id);
    result.set(key, closedStateOf(line, byLine.get(key) ?? []));
  }
  return result;
}

/** What a refused request says, by why the line is closed. */
export function closedMessage(state: Exclude<LineClosed, null>): string {
  switch (state) {
    case 'confirmed':
      return 'The seller is still processing the last confirmation on this offer. Try again in a moment.';
    case 'short':
      return 'The seller could not send all the boxes asked for on this offer, and the desk is deciding who gets them. It takes no more requests until then.';
    case 'requoted':
      return 'The seller has revised this offer and is waiting on the buyers, so it takes no more requests.';
    case 'declined':
      return 'The seller declined this offer, so it takes no more requests.';
    case 'sold_out':
      return 'This offer is sold out.';
  }
}
