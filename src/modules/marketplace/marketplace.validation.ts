import { z } from 'zod';
import { STOP_REASON_CODES } from '../../models/Listing.js';

// The note is the detail the fixed reason code cannot carry; it is always required (RECTIFY-01 §1.1).
const stopNote = z
  .string({ error: 'Say why, in a few words.' })
  .trim()
  .min(1, 'Say why, in a few words.')
  .max(500, 'Keep the note under 500 characters.');
const stopReason = z.enum(STOP_REASON_CODES, { error: 'Pick a reason.' });

/**
 * POST /staff/listings/:id/stop. With `confirm` false or absent nothing is written and the call
 * answers with the impact preview. `confirmPools` is Admin's, for a listing whose seller supplies a
 * pool someone is committed to; `confirmPaidPools` is Admin's second tick when a commitment in it is paid.
 */
export const stopListingSchema = z
  .object({
    reasonCode: stopReason,
    note: stopNote,
    confirm: z.boolean().optional(),
    confirmPools: z.boolean().optional(),
    confirmPaidPools: z.boolean().optional(),
  })
  .strict();

/** POST /staff/quotes/:id/withdraw — the same dropdown and note, the same preview-then-confirm. */
export const withdrawQuoteSchema = z
  .object({
    reasonCode: stopReason,
    note: stopNote,
    confirm: z.boolean().optional(),
  })
  .strict();

/** POST /staff/listings/:id/restart — nothing is needed; a note is welcome. */
export const restartListingSchema = z
  .object({ note: z.string().trim().max(500, 'Keep the note under 500 characters.').optional() })
  .strict();
