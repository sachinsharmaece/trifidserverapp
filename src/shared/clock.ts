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
