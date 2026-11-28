/**
 * Date maths for the dormant policy (reference lib/dormancy/clockMath.ts), all in Indian time (UTC+5:30, no
 * daylight saving). "Day N" means N calendar days after the start date. No database here, so it is easy to test.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORK_START_MIN = 9 * 60 + 30; // 09:30
const WORK_END_MIN = 19 * 60; // 19:00

/** The Indian calendar date of an instant, as a UTC midnight (so whole days can be counted). */
function istMidnight(date: Date): number {
  const shifted = date.getTime() + IST_OFFSET_MS;
  return shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Minutes since Indian midnight. */
function istMinutesOfDay(date: Date): number {
  return Math.floor((date.getTime() + IST_OFFSET_MS - istMidnight(date)) / 60000);
}

/** Calendar days from `from` to `to` in Indian dates: the same date is 0, even if less than 24 hours apart is 1. */
export function calendarDaysBetweenIST(from: Date, to: Date): number {
  return Math.round((istMidnight(to) - istMidnight(from)) / DAY_MS);
}

/**
 * Working hours are 09:30 to 19:00, Monday to Saturday (Sunday does not count). Returns the moment `hours` working
 * hours after `start`; a start outside working time counts from the next working minute.
 */
export function addWorkingHoursIST(start: Date, hours: number): Date {
  let remaining = Math.round(hours * 60);
  let midnight = istMidnight(start); // a UTC midnight standing for the Indian date
  let minutes = istMinutesOfDay(start);
  for (let guard = 0; guard < 1000; guard++) {
    const isSunday = new Date(midnight).getUTCDay() === 0;
    if (!isSunday) {
      const from = Math.max(minutes, WORK_START_MIN);
      const available = Math.max(0, WORK_END_MIN - from);
      if (remaining <= available)
        return new Date(midnight - IST_OFFSET_MS + (from + remaining) * 60000);
      remaining -= available;
    }
    midnight += DAY_MS;
    minutes = 0;
  }
  throw new Error('addWorkingHoursIST: too many days');
}

export interface Bill {
  date: Date;
  netAmountPaise: number;
  id: string;
}

/**
 * When the ordered-party clock started (reference §4.2): the date of the bill that took the running total to the
 * threshold, the total then starting again from 0 (what is left over is not carried). With no bill reaching it,
 * the first bill's date. `bills` must be sorted by date, then id. Null when there are no bills.
 */
export function clockStart(bills: Bill[], thresholdPaise: number): Date | null {
  const first = bills[0];
  if (!first) return null;
  let start = first.date;
  let total = 0;
  for (const bill of bills) {
    total += bill.netAmountPaise;
    if (total >= thresholdPaise) {
      start = bill.date;
      total = 0;
    }
  }
  return start;
}
