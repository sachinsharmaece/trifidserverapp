/**
 * ARCHITECTURE.md §11 — store UTC, display Asia/Kolkata, never store a local-time string.
 * DEC-011 — all clocks are pure calendar hours, Sunday included.
 */

export const DISPLAY_TIMEZONE = 'Asia/Kolkata';

export function now(): Date {
  return new Date();
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addHours(date, days * 24);
}

// BR-231 — the one clock exception: the four-hour head start counts working
// hours only, 09:30–19:00, Monday to Saturday (Sunday excluded). Every other
// clock in the system is pure calendar hours (BR-230) — do not reuse this
// for anything else.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WORK_DAY_START_MS = 9.5 * HOUR_MS; // 09:30
const WORK_DAY_END_MS = 19 * HOUR_MS; // 19:00

// M8 — the working day is an IST fact (CH §9.3.2 / ARCHITECTURE.md §11), not a
// property of whichever machine runs the worker. India has no daylight saving,
// so a fixed +05:30 offset is exact. (This function previously read the server's
// local time, which is only correct on a host already set to IST.)
const IST_OFFSET_MS = 5.5 * HOUR_MS;

export function addWorkingHours(date: Date, hoursToAdd: number): Date {
  let remainingMs = hoursToAdd * HOUR_MS;
  let cursor = date.getTime(); // Real epoch milliseconds throughout.

  while (remainingMs > 0) {
    // Read the IST wall clock: shift by the offset, then use UTC arithmetic.
    const istMs = cursor + IST_OFFSET_MS;
    const msIntoDay = ((istMs % DAY_MS) + DAY_MS) % DAY_MS;
    const istDayStart = cursor - msIntoDay;
    const weekday = new Date(istMs).getUTCDay(); // 0 = Sunday, in IST.

    if (weekday === 0 || msIntoDay >= WORK_DAY_END_MS) {
      // Sunday, or past close — jump to the next day's open.
      cursor = istDayStart + DAY_MS + WORK_DAY_START_MS;
      continue;
    }
    if (msIntoDay < WORK_DAY_START_MS) {
      cursor = istDayStart + WORK_DAY_START_MS;
      continue;
    }

    const consume = Math.min(remainingMs, WORK_DAY_END_MS - msIntoDay);
    cursor += consume;
    remainingMs -= consume;
  }

  return new Date(cursor);
}

/** The IST calendar date of an instant, as `YYYY-MM-DD` — for "same day" comparisons (BR-174). */
export function istDateKey(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isPast(date: Date): boolean {
  return date.getTime() < Date.now();
}

export function formatForDisplay(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: DISPLAY_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
