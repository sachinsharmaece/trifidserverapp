import { describe, expect, it } from 'vitest';
import {
  clockStart,
  daysBetween,
  firstCallDueAt,
  onOrAfterDay,
  windowStep,
  type Bill,
} from '../src/modules/holding/holding.rules.js';
import { isPlaceholderMobile, isPlaceholderTehsil } from '../src/shared/placeholders.js';

/** Noon IST on a calendar day: far from midnight, so the day never wobbles. */
const ist = (day: string, time = '12:00:00') => new Date(`${day}T${time}+05:30`);
const THRESHOLD = 10_000 * 100; // ₹10,000 in paise

const bill = (day: string, rupees: number, id = day): Bill => ({
  date: ist(day),
  netPaise: rupees * 100,
  id,
});

describe('LOCK-34 — days are IST calendar days', () => {
  it('counts whole days, whatever the time of day', () => {
    expect(daysBetween(ist('2026-01-01', '00:05:00'), ist('2026-01-02', '23:55:00'))).toBe(1);
    expect(daysBetween(ist('2026-01-01'), ist('2026-04-01'))).toBe(90);
    expect(daysBetween(ist('2026-01-01'), ist('2026-03-31'))).toBe(89);
  });

  it('reads 00:30 IST as the new day even though UTC is still the day before', () => {
    expect(daysBetween(ist('2026-01-01', '23:30:00'), ist('2026-01-02', '00:30:00'))).toBe(1);
    expect(onOrAfterDay(ist('2026-01-02', '00:30:00'), ist('2026-01-02', '23:00:00'))).toBe(true);
  });
});

describe('LOCK-34 §4.2 — when the billing clock starts', () => {
  it('has no start without a bill', () => {
    expect(clockStart([], THRESHOLD)).toBeNull();
  });

  it('never restarts on ₹9,999 in total', () => {
    const bills = [bill('2026-01-05', 4999), bill('2026-02-01', 5000)];
    expect(clockStart(bills, THRESHOLD)).toEqual(ist('2026-01-05'));
  });

  it('restarts exactly at the threshold, in paise', () => {
    expect(clockStart([bill('2026-01-05', 10_000)], THRESHOLD)).toEqual(ist('2026-01-05'));
    const justShort = [{ date: ist('2026-01-05'), netPaise: THRESHOLD - 1, id: 'a' }];
    const second = { date: ist('2026-03-01'), netPaise: 1, id: 'b' };
    expect(clockStart([...justShort, second], THRESHOLD)).toEqual(ist('2026-03-01'));
  });

  it('₹4,000 on day 20 then ₹7,000 on day 50 restarts on day 50; ₹9,000 more does not', () => {
    const base = [bill('2026-01-21', 4000), bill('2026-02-20', 7000)];
    expect(clockStart(base, THRESHOLD)).toEqual(ist('2026-02-20'));
    // The remainder is not carried: ₹1,000 over the line plus ₹9,000 is still short.
    expect(clockStart([...base, bill('2026-03-10', 9000)], THRESHOLD)).toEqual(ist('2026-02-20'));
  });

  it('takes bills by date then id, whatever order they arrive in', () => {
    const bills = [bill('2026-02-20', 7000, 'b'), bill('2026-01-21', 4000, 'a')];
    expect(clockStart(bills, THRESHOLD)).toEqual(ist('2026-02-20'));
    const sameDay = [bill('2026-02-01', 6000, 'z'), bill('2026-02-01', 5000, 'a')];
    expect(clockStart(sameDay, THRESHOLD)).toEqual(ist('2026-02-01'));
  });
});

describe('LOCK-34 §4.3 — the reason window', () => {
  const base = { limit: 90, windowDays: 7 };
  const start = ist('2026-01-01');

  it('does nothing on day 89, opens on day 90', () => {
    expect(windowStep({ ...base, start, today: ist('2026-03-31'), windowOpenedAt: null })).toBe(
      'none',
    );
    expect(windowStep({ ...base, start, today: ist('2026-04-01'), windowOpenedAt: null })).toBe(
      'open',
    );
  });

  it('releases seven days after the window opened, not before', () => {
    const opened = ist('2026-04-01');
    expect(windowStep({ ...base, start, today: ist('2026-04-07'), windowOpenedAt: opened })).toBe(
      'none',
    );
    expect(windowStep({ ...base, start, today: ist('2026-04-08'), windowOpenedAt: opened })).toBe(
      'release',
    );
  });

  it('catches up after a missed night: the window opens late, then gets its full week', () => {
    expect(windowStep({ ...base, start, today: ist('2026-04-10'), windowOpenedAt: null })).toBe(
      'open',
    );
  });
});

describe('LOCK-34 §4.5 — first call within 4 working hours (09:30–19:00, Mon–Sat)', () => {
  it('Saturday 18:30 is due Monday 13:00', () => {
    expect(firstCallDueAt(ist('2026-11-07', '18:30:00'), 4)).toEqual(ist('2026-11-09', '13:00:00'));
  });
  it('Monday 08:00 is due Monday 13:30', () => {
    expect(firstCallDueAt(ist('2026-11-09', '08:00:00'), 4)).toEqual(ist('2026-11-09', '13:30:00'));
  });
  it('Friday 17:00 is due Saturday 11:30', () => {
    expect(firstCallDueAt(ist('2026-11-06', '17:00:00'), 4)).toEqual(ist('2026-11-07', '11:30:00'));
  });
});

describe('LOCK-34 §12.1 — placeholder data', () => {
  it('knows the placeholder mobiles (9999999991 upward) and no real one', () => {
    expect(isPlaceholderMobile('9999999991')).toBe(true);
    expect(isPlaceholderMobile('9999999999')).toBe(true);
    expect(isPlaceholderMobile('9999999990')).toBe(false);
    expect(isPlaceholderMobile('9876543210')).toBe(false);
    expect(isPlaceholderMobile(null)).toBe(false);
  });

  it('knows the placeholder tehsil, in any case', () => {
    expect(isPlaceholderTehsil('zzzzz')).toBe(true);
    expect(isPlaceholderTehsil(' ZZZZZ ')).toBe(true);
    expect(isPlaceholderTehsil('Mhow')).toBe(false);
    expect(isPlaceholderTehsil(undefined)).toBe(false);
  });
});
