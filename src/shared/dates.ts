import { z } from 'zod';

/** Today's date in India (IST, UTC+5:30), YYYY-MM-DD. Business dates in the books are Indian dates. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A real calendar date typed as YYYY-MM-DD ("2026-02-30" is refused). */
export const isoDateField = (message: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)
    .refine((text) => {
      const parsed = new Date(`${text}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
    }, message);
