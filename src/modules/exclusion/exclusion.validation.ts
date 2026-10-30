import { z } from 'zod';

// Phase 3 (DEC-054) — a buyer without a GSTIN is blocked by his PAN.
const gstinSchema = z
  .string()
  .regex(
    /^([0-9A-Z]{15}|[A-Z]{5}[0-9]{4}[A-Z])$/,
    "Enter the buyer's 15-character GSTIN, or his 10-character PAN if he has no GSTIN.",
  );

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
