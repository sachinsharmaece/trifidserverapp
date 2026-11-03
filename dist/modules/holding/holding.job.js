import { Holding } from '../../models/Holding.js';
import { logger } from '../../shared/logger.js';
import { billsForMany } from './holding.bills.js';
import { clockStart, daysBetween, onOrAfterDay, windowStep } from './holding.rules.js';
import { getSettings } from './holding.settings.js';
import { convertHolding, ineligiblePartyIds, releaseHolding } from './holding.service.js';
/**
 * LOCK-34 §7 — the nightly clocks. For every open holding: convert it if the
 * party has billed, open its reason window when its days are up, release it when
 * the window ends. `now` is a parameter so a test can set the date.
 *
 * Safe to run twice in a day: every change is conditional on the holding still
 * being in the state this run saw, and the window-opening rule is "has it been
 * N days", so a night the worker missed is simply caught up the next time.
 *
 * Whether it runs at all at night is decided by the worker (DORMANCY_JOB_ENABLED);
 * this function itself only needs the admin switch to be on.
 */
const id = (value) => String(value);
export async function runDormancyClocks(now = new Date()) {
    const settings = await getSettings();
    if (!settings.enabled)
        return null;
    const summary = {
        converted: 0,
        windowsOpened: 0,
        windowsCleared: 0,
        released: 0,
        backlogOpened: 0,
        closedIneligible: 0,
    };
    const holdings = await Holding.find({ isOpen: true }).lean();
    const partyIds = [...new Set(holdings.map((h) => id(h.partyId)))];
    const [bad, bills] = await Promise.all([
        ineligiblePartyIds(partyIds),
        billsForMany(partyIds, settings.goLiveDate),
    ]);
    const step = async (h, start, limit) => {
        const action = windowStep({
            start,
            today: now,
            limit,
            windowOpenedAt: h.windowOpenedAt,
            windowDays: settings.reasonWindowDays,
        });
        if (action === 'open') {
            const opened = await Holding.updateOne({ _id: h._id, isOpen: true, windowOpenedAt: null }, { $set: { windowOpenedAt: now } });
            summary.windowsOpened += opened.modifiedCount;
        }
        else if (action === 'release') {
            if (await releaseHolding(id(h._id), now))
                summary.released += 1;
        }
    };
    const backlogQueue = [];
    for (const h of holdings) {
        const party = id(h.partyId);
        // A rejected, blacklisted or deleted firm leaves quietly: it never reaches the Pool.
        if (bad.has(party)) {
            if (await releaseHolding(id(h._id), now))
                summary.closedIneligible += 1;
            continue;
        }
        const partyBills = bills.get(party) ?? [];
        if (h.kind === 'lead') {
            // The first bill, of any amount, makes him a book.
            const first = [...partyBills]
                .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id))
                .find((b) => onOrAfterDay(b.date, h.startedAt));
            if (first) {
                if (await convertHolding(id(h._id), 'ordered', first.date, now))
                    summary.converted += 1;
                continue;
            }
            await step(h, h.startedAt, settings.leadDays);
        }
        else if (h.kind === 'claim') {
            // A restart on or after the claim began closes the claim and opens a book.
            const restart = clockStart(partyBills, settings.billingThresholdPaise);
            if (restart && onOrAfterDay(restart, h.startedAt)) {
                if (await convertHolding(id(h._id), 'billed', restart, now))
                    summary.converted += 1;
                continue;
            }
            await step(h, h.startedAt, settings.leadDays);
        }
        else {
            const start = clockStart(partyBills, settings.billingThresholdPaise);
            if (!start)
                continue;
            // A restart while the window is open cancels it; the holder keeps the party.
            if (h.windowOpenedAt && onOrAfterDay(start, h.windowOpenedAt)) {
                await Holding.updateOne({ _id: h._id, isOpen: true }, { $unset: { windowOpenedAt: '', backlog: '' } });
                summary.windowsCleared += 1;
                continue;
            }
            if (h.backlog && !h.windowOpenedAt) {
                if (daysBetween(start, now) < settings.orderedDays) {
                    // He billed before his turn came: no longer backlog.
                    await Holding.updateOne({ _id: h._id, isOpen: true }, { $unset: { backlog: '' } });
                }
                else {
                    backlogQueue.push({ holding: h, clock: start });
                    continue;
                }
            }
            await step(h, start, settings.orderedDays);
        }
    }
    // Backlog: open windows for at most `backlogPerWeek` in any 7 days, oldest last bill first.
    if (backlogQueue.length > 0) {
        const recent = await Holding.find({ backlog: true, windowOpenedAt: { $ne: null } }, { windowOpenedAt: 1 }).lean();
        const used = recent.filter((r) => daysBetween(r.windowOpenedAt, now) < 7).length;
        const room = Math.max(0, settings.backlogPerWeek - used);
        const next = backlogQueue
            .sort((a, b) => a.clock.getTime() - b.clock.getTime() ||
            id(a.holding._id).localeCompare(id(b.holding._id)))
            .slice(0, room);
        for (const { holding } of next) {
            const opened = await Holding.updateOne({ _id: holding._id, isOpen: true, windowOpenedAt: null }, { $set: { windowOpenedAt: now } });
            summary.backlogOpened += opened.modifiedCount;
        }
    }
    logger.info({ msg: 'LOCK-34 clocks ran', ...summary });
    return summary;
}
