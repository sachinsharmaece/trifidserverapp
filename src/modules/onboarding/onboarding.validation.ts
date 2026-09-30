import { z } from 'zod';
import { isValidGstin, isValidLicenceNo } from '../../shared/validators.js';

const mobileSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');
// B-48 — this used to be shape+checksum via `isValidGstin` (same pattern as
// `isValidHsn` elsewhere); somewhere it was pared back to a bare length
// check, which is how a 15-character but checksum-invalid GSTIN got past
// this boundary. Restoring the existing validator rather than writing a new
// one — `assertGstinAndMobileAreFree` in onboarding.service.ts still ran
// the real check below this layer, so this was defense-in-depth lost, not
// the only gate.
const gstinSchema = z
  .string()
  .length(15, 'GSTIN must be 15 characters.')
  .refine(isValidGstin, { message: 'That GSTIN does not check out.' });
const ifscSchema = z.string().length(11, 'IFSC must be 11 characters.');
const licenceNoSchema = z
  .string()
  .min(1, 'Enter the insecticide licence number.')
  .refine(isValidLicenceNo, { message: 'Enter a valid licence number (at least 4 characters).' });

// B-49 — same root cause as B-25/B-48: a bare `.min(1)` with no message
// renders Zod's own internal wording ("Too small: expected string to have
// >=1 characters") straight to a user instead of a field-level message like
// every other field in this file already carries. Restoring one per field
// rather than leaving the raw library output visible.
const bankDetailInputSchema = z
  .object({
    accountNumber: z.string().min(4, 'Enter the bank account number.').max(34),
    ifsc: ifscSchema,
    accountName: z.string().min(1, 'Enter the name on the bank account.'),
  })
  .strict();

const consentInputSchema = z
  .object({
    noticeVersion: z.string().min(1, 'A consent notice version is required.'),
    marketingOptIn: z.boolean(),
  })
  .strict();

export const registerBuyerSchema = z
  .object({
    mobile: mobileSchema,
    firm: z.string().min(1, 'Enter the firm name.'),
    gstin: gstinSchema,
    ownerName: z.string().min(1, 'Enter the owner name.'),
    licenceNo: licenceNoSchema,
    gstPpobAddress: z.string().min(1, 'Enter the GST principal place of business.'),
    dealerships: z
      .array(
        z
          .object({
            manufacturerId: z.string().min(1, 'A dealership entry needs a company.'),
            isStrong: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    // B-25 — bank detail is mandatory for a seller (he is paid) but not for
    // a buyer (he pays TriFid; a refund destination traces to the payment
    // itself, BR-018). Only this field's requiredness changes here.
    bankDetail: bankDetailInputSchema.optional(),
    consent: consentInputSchema,
  })
  .strict();

export const registerSellerSchema = z
  .object({
    mobile: mobileSchema,
    firm: z.string().min(1, 'Enter the firm name.'),
    gstin: gstinSchema,
    ownerName: z.string().min(1, 'Enter the owner name.'),
    licenceNo: licenceNoSchema,
    // BR-250 — two or more named referees.
    references: z
      .array(
        z
          .object({
            firm: z.string().min(1, "Enter the referee's firm."),
            phone: mobileSchema,
            relationship: z.string().min(1, 'Enter the relationship to this referee.'),
            whatTheySaid: z.string().min(1, 'Enter what the referee said.'),
          })
          .strict(),
      )
      .min(2, 'Two referees are required (BR-250).'),
    bankDetail: bankDetailInputSchema,
    consent: consentInputSchema,
  })
  .strict();

// Staff-assisted enquiries — same body as the self-service registration,
// plus the mandatory call note. Desk boundary (Sales=buyer, Purchase=seller)
// is checked in the controller against the caller's permission, not here.
export const staffRegisterBuyerSchema = registerBuyerSchema.extend({
  callNote: z.string().min(1, 'A call note is required for a staff-assisted registration.'),
});

export const staffRegisterSellerSchema = registerSellerSchema.extend({
  callNote: z.string().min(1, 'A call note is required for a staff-assisted registration.'),
});

export const listRegistrationsQuerySchema = z
  .object({
    stage: z.enum(['pending', 'active', 'rejected']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const approveBuyerSchema = z
  .object({
    tehsilId: z.string().min(1, 'A tehsil is required (BR-081).'),
    tradePosition: z.enum(['distributor', 'dealer', 'retailer']),
    isTrader: z.boolean(),
  })
  .strict();

export const approveSellerSchema = z
  .object({
    tehsilIds: z.array(z.string().min(1)).min(1, 'At least one tehsil is required (BR-083).'),
    dispatchCutoffTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a cut-off time as HH:MM, 24-hour.'),
    trustTier: z.enum(['New', 'Verified', 'Trusted', 'Committed']).optional(),
    seedReason: z.string().optional(),
  })
  .strict();

export const rejectRegistrationSchema = z
  .object({
    reason: z.string().min(1, 'A reason is required to reject a registration.'),
  })
  .strict();

export const bankDetailChangeSchema = bankDetailInputSchema;
