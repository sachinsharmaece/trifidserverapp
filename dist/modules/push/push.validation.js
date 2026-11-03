import { z } from 'zod';
import { approveSellerSchema, bankDetailInputSchema, gstinSchema, locationSchema, optionalLicence, optionalMargCode, registerSellerSchema, } from '../onboarding/onboarding.validation.js';
const objectId = (what) => z.string().regex(/^[a-f0-9]{24}$/i, `Pick ${what} from the list.`);
/**
 * Sales — Push to Purchase. Only a note; Admin may name the receiver.
 * 3 Nov (My view sheet) — the note is optional; one that is given is still kept to 1000 characters.
 */
export const createPushSchema = z
    .object({
    note: z.string().trim().max(1000).default(''),
    receiverEmployeeId: objectId('the Purchase executive').optional(),
})
    .strict();
/**
 * A referee Purchase has started: a firm and a valid phone, as on the staff "Add a seller" form
 * (DEC-069). 3 Nov (My view sheet) — how he is related and what he said are optional.
 */
const pushRefereeSchema = registerSellerSchema.shape.references.element.extend({
    relationship: z.string().trim().default(''),
    whatTheySaid: z.string().trim().default(''),
});
/**
 * Purchase — the first call done, the seller fields completed. The GSTIN is
 * needed only when the buyer had a PAN alone.
 *
 * 3 Nov (My view sheet) — the licence, the referees, the bank account and the call note are all
 * optional (the same relaxation DEC-069 gave the staff "Add a seller" form). What is given is
 * still checked: a licence of at least 4 characters, a referee's firm and a valid phone, and all
 * three bank fields together. Without a bank account he cannot be paid until staff add one.
 */
export const completePushSchema = z
    .object({
    gstin: z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() || undefined : value), gstinSchema.optional()),
    licenceNo: optionalLicence,
    location: locationSchema,
    references: z.array(pushRefereeSchema).default([]),
    dealerships: registerSellerSchema.shape.dealerships,
    bankDetail: bankDetailInputSchema.optional(),
    margPartyCode: optionalMargCode,
    callNote: z.string().trim().default(''),
})
    .strict();
/** Purchase Leader — the same decisions as a seller approval (API-014). */
export const approvePushSchema = approveSellerSchema.omit({ location: true });
export const rejectPushSchema = z
    .object({ reason: z.string().trim().min(1, 'A reason is required to reject.') })
    .strict();
export const listPushesQuerySchema = z
    .object({ status: z.enum(['open', 'pending', 'submitted', 'approved', 'rejected']).optional() })
    .strict();
