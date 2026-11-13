import { addWorkingHours, istDateKey } from '../../shared/clock.js';
/**
 * LOCK-34 — the pure rules. No database in this file, so every rule here can
 * be tested with plain numbers and dates. All dates are Asia/Kolkata calendar
 * days; "day N" is N calendar days after the start date (the start is day 0).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole IST calendar days from `from` to `to` (never mind the time of day). */
export function daysBetween(from, to) {
    const start = Date.parse(`${istDateKey(from)}T00:00:00Z`);
    const end = Date.parse(`${istDateKey(to)}T00:00:00Z`);
    return Math.round((end - start) / DAY_MS);
}
/** `a` falls on the same IST day as `b`, or later. */
export function onOrAfterDay(a, b) {
    return istDateKey(a) >= istDateKey(b);
}
/** A `YYYY-MM-DD` setting read as midnight IST. */
export function istMidnight(day) {
    return new Date(`${day}T00:00:00+05:30`);
}
/**
 * §4.2 — when the billing clock last (re)started. A bill's value adds up until
 * it reaches the threshold; the bill that reaches it restarts the clock on its
 * own date, and the remainder is not carried. Bills are taken by date, then id.
 * `null` when there are no bills at all.
 */
export function clockStart(bills, thresholdPaise) {
    if (bills.length === 0)
        return null;
    const ordered = [...bills].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
    let start = ordered[0].date;
    let total = 0;
    for (const bill of ordered) {
        total += bill.netPaise;
        if (total >= thresholdPaise) {
            start = bill.date;
            total = 0;
        }
    }
    return start;
}
/**
 * §7 `step` — what a holding needs today. The reason window opens once `limit`
 * days have passed since `start`, and the party is released `windowDays` days
 * after the window opened. Both are "has it been at least N days", so a job
 * that missed a night simply catches up.
 */
export function windowStep(input) {
    if (!input.windowOpenedAt) {
        return daysBetween(input.start, input.today) >= input.limit ? 'open' : 'none';
    }
    return daysBetween(input.windowOpenedAt, input.today) >= input.windowDays ? 'release' : 'none';
}
/** §4.5 — a lead assigned at `assignedAt` must be rung within `hours` working hours. */
export function firstCallDueAt(assignedAt, hours) {
    return addWorkingHours(assignedAt, hours);
}
