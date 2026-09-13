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
const WORK_DAY_START_HOUR = 9.5;
const WORK_DAY_END_HOUR = 19;

export function addWorkingHours(date: Date, hoursToAdd: number): Date {
  let remaining = hoursToAdd;
  let cursor = new Date(date);

  while (remaining > 0) {
    const day = cursor.getDay(); // 0 = Sunday.
    const hourOfDay = cursor.getHours() + cursor.getMinutes() / 60;

    if (day === 0 || hourOfDay >= WORK_DAY_END_HOUR) {
      // Sunday, or past close — jump to next day's open.
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(Math.floor(WORK_DAY_START_HOUR), (WORK_DAY_START_HOUR % 1) * 60, 0, 0);
      continue;
    }
    if (hourOfDay < WORK_DAY_START_HOUR) {
      cursor.setHours(Math.floor(WORK_DAY_START_HOUR), (WORK_DAY_START_HOUR % 1) * 60, 0, 0);
      continue;
    }

    const hoursLeftToday = WORK_DAY_END_HOUR - hourOfDay;
    const consume = Math.min(remaining, hoursLeftToday);
    cursor = new Date(cursor.getTime() + consume * 60 * 60 * 1000);
    remaining -= consume;
  }

  return cursor;
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
