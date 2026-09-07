import { z } from 'zod';

const gstinSchema = z.string().regex(/^[0-9A-Z]{15}$/, 'Enter a valid 15-character GSTIN.');

export const lookupSchema = z
  .object({
    gstin: gstinSchema,
  })
  .strict();

// BR-090 — no reason field is accepted, even if one is sent. `.strict()`
// already rejects an unknown `reason` key outright rather than silently
// dropping it, which is the stronger guarantee.
export const createExclusionSchema = z
  .object({
    gstin: gstinSchema,
  })
  .strict();
