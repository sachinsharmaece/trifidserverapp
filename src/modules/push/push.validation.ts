import { z } from 'zod';
import {
  approveSellerSchema,
  bankDetailInputSchema,
  gstinSchema,
  licenceNoSchema,
  locationSchema,
  optionalMargCode,
  registerSellerSchema,
} from '../onboarding/onboarding.validation.js';

const objectId = (what: string) =>
  z.string().regex(/^[a-f0-9]{24}$/i, `Pick ${what} from the list.`);

/** Sales — Push to Purchase. Only a note; Admin may name the receiver. */
export const createPushSchema = z
  .object({
    note: z.string().trim().min(3, 'Say what he can supply.').max(1000),
    receiverEmployeeId: objectId('the Purchase executive').optional(),
  })
  .strict();
export type CreatePushInput = z.infer<typeof createPushSchema>;

/**
 * Purchase — the first call done, the seller fields completed. The GSTIN is
 * needed only when the buyer had a PAN alone; the bank detail only when the
 * firm has none on file yet (the service says which).
 */
export const completePushSchema = z
  .object({
    gstin: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toUpperCase() || undefined : value),
      gstinSchema.optional(),
    ),
    licenceNo: licenceNoSchema,
    location: locationSchema,
    references: registerSellerSchema.shape.references,
    dealerships: registerSellerSchema.shape.dealerships,
    bankDetail: bankDetailInputSchema.optional(),
    margPartyCode: optionalMargCode,
    callNote: z.string().trim().min(1, 'A call note is required.'),
  })
  .strict();
export type CompletePushInput = z.infer<typeof completePushSchema>;

/** Purchase Leader — the same decisions as a seller approval (API-014). */
export const approvePushSchema = approveSellerSchema.omit({ location: true });
export type ApprovePushInput = z.infer<typeof approvePushSchema>;

export const rejectPushSchema = z
  .object({ reason: z.string().trim().min(1, 'A reason is required to reject.') })
  .strict();

export const listPushesQuerySchema = z
  .object({ status: z.enum(['open', 'pending', 'submitted', 'approved', 'rejected']).optional() })
  .strict();
export type ListPushesQuery = z.infer<typeof listPushesQuerySchema>;
