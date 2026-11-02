import { Pile } from '../../models/Pile.js';
/**
 * `null` = it takes requests (an open group, or the next one can open). Otherwise why not:
 *  - `confirmed` — the seller confirmed it and its orders are not made yet;
 *  - `short` — the seller can send fewer boxes than were asked and the desk has still to say who
 *    gets them (BR-134);
 *  - `requoted` — the seller revised it and the buyers have yet to accept or cancel;
 *  - `declined` — the seller turned it down;
 *  - `sold_out` — it was filled and no stock is left.
 */
export function closedStateOf(line, groups) {
    if (groups.some((g) => !g.decision))
        return null; // An open group takes more.
    const latest = [...groups].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
    if (!latest)
        return null; // Never piled: nothing has been decided.
    if (latest.decision === 'requoted')
        return 'requoted';
    if (latest.decision === 'declined')
        return 'declined';
    // Confirmed. In flight until the fan-out has run, and while a short pile awaits the desk.
    if (!latest.executedAt)
        return 'confirmed';
    if (latest.shortfall && !latest.shortfallResolved)
        return 'short';
    return line.qty >= 1 ? null : 'sold_out';
}
/** A stored group, as the rule reads it. */
export function groupFacts(pile) {
    return {
        decision: (pile.decision ?? null),
        executedAt: pile.executedAt ?? null,
        shortfall: Boolean(pile.shortfall),
        shortfallResolved: Boolean(pile.shortfallResolvedAt),
        openedAt: pile.openedAt,
    };
}
/** The state for many lines at once: one read, however long the board is. */
export async function closedStateByLine(lines) {
    const result = new Map();
    if (lines.length === 0)
        return result;
    const piles = await Pile.find({ listingLineId: { $in: lines.map((l) => l._id) } }, {
        listingLineId: 1,
        decision: 1,
        executedAt: 1,
        shortfall: 1,
        shortfallResolvedAt: 1,
        openedAt: 1,
    });
    const byLine = new Map();
    for (const pile of piles) {
        const key = pile.listingLineId.toString();
        byLine.set(key, [...(byLine.get(key) ?? []), groupFacts(pile)]);
    }
    for (const line of lines) {
        const key = String(line._id);
        result.set(key, closedStateOf(line, byLine.get(key) ?? []));
    }
    return result;
}
/** What a refused request says, by why the line is closed. */
export function closedMessage(state) {
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
