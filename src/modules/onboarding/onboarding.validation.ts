import { z } from 'zod';
import {
  isValidGstin,
  isValidLicenceNo,
  isValidPan,
  isValidPincode,
  normalizeMobile,
  isValidMobile,
  panFromGstin,
} from '../../shared/validators.js';

export const mobileSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');
// B-48 — this used to be shape+checksum via `isValidGstin` (same pattern as
// `isValidHsn` elsewhere); somewhere it was pared back to a bare length
// check, which is how a 15-character but checksum-invalid GSTIN got past
// this boundary. Restoring the existing validator rather than writing a new
// one — `assertGstinAndMobileAreFree` in onboarding.service.ts still ran
// the real check below this layer, so this was defense-in-depth lost, not
// the only gate.
export const gstinSchema = z
  .string()
  .length(15, 'GSTIN must be 15 characters.')
  .refine(isValidGstin, { message: 'That GSTIN does not check out.' });
const ifscSchema = z.string().length(11, 'IFSC must be 11 characters.');
export const licenceNoSchema = z
  .string()
  .min(1, 'Enter the insecticide licence number.')
  .refine(isValidLicenceNo, { message: 'Enter a valid licence number (at least 4 characters).' });

// B-49 — same root cause as B-25/B-48: a bare `.min(1)` with no message
// renders Zod's own internal wording ("Too small: expected string to have
// >=1 characters") straight to a user instead of a field-level message like
// every other field in this file already carries. Restoring one per field
// rather than leaving the raw library output visible.
export const bankDetailInputSchema = z
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

// Phase 3 (DEC-054) — a buyer is identified by his GSTIN, or by his PAN when
// he has none. Blank strings count as "not given".
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalGstin = z.preprocess(
  (value) => (typeof value === 'string' ? blankToUndefined(value.trim().toUpperCase()) : value),
  gstinSchema.optional(),
);
const optionalPan = z.preprocess(
  (value) => (typeof value === 'string' ? blankToUndefined(value.trim().toUpperCase()) : value),
  z
    .string()
    .refine((v) => isValidPan(v), 'Enter the PAN as 5 letters, 4 digits and 1 letter.')
    .optional(),
);

function refineGstinOrPan(body: { gstin?: string; pan?: string }, ctx: z.RefinementCtx): void {
  if (!body.gstin && !body.pan) {
    ctx.addIssue({
      code: 'custom',
      path: ['gstin'],
      message: 'Enter the GSTIN — or the PAN, if he has no GSTIN.',
    });
    return;
  }
  refinePanMatchesGstin(body, ctx);
}

// DEC-068 — staff may register or keep a buyer with neither GSTIN nor PAN
// (a lead from a dealer list). Only a PAN that contradicts the GSTIN is wrong.
function refinePanMatchesGstin(body: { gstin?: string; pan?: string }, ctx: z.RefinementCtx): void {
  if (body.gstin && body.pan && body.pan !== panFromGstin(body.gstin)) {
    ctx.addIssue({
      code: 'custom',
      path: ['pan'],
      message: 'This PAN does not match the GSTIN (characters 3–12 of a GSTIN are its PAN).',
    });
  }
}

export const registerBuyerSchema = z
  .object({
    mobile: mobileSchema,
    firm: z.string().min(1, 'Enter the firm name.'),
    gstin: optionalGstin,
    pan: optionalPan,
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
  .strict()
  .superRefine(refineGstinOrPan);

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
    // The companies he deals in — every product of each counts as carried.
    dealerships: z
      .array(
        z
          .object({ manufacturerId: z.string().min(1, 'A dealership entry needs a company.') })
          .strict(),
      )
      .optional(),
    bankDetail: bankDetailInputSchema,
    consent: consentInputSchema,
  })
  .strict();

const objectId = (what: string) =>
  z.string().regex(/^[a-f0-9]{24}$/i, `Pick ${what} from the list.`);

export const BUYER_CATEGORIES = ['Retailer', 'Dealer', 'Distributor', 'Trader'] as const;
const categorySchema = z.enum(BUYER_CATEGORIES, { message: 'Pick the category.' });

// The LocationBlock (Phase 1): address, pincode, then State → District →
// Tehsil. Tehsil is the one the resolver reads (BR-081); an unknown pincode
// is saved against it as unverified (BR-349).
export const locationSchema = z
  .object({
    address: z.string().trim().min(5, 'Enter the address.'),
    pincode: z.preprocess(
      (value) => (typeof value === 'string' ? blankToUndefined(value.trim()) : value),
      z
        .string()
        .refine(isValidPincode, 'Enter a 6-digit pincode that does not start with 0.')
        .optional(),
    ),
    stateId: objectId('the state'),
    districtId: objectId('the district'),
    tehsilId: objectId('the tehsil'),
  })
  .strict();

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' ? blankToUndefined(value.trim()) : value),
  z.string().optional(),
);

const optionalLicence = z.preprocess(
  (value) => (typeof value === 'string' ? blankToUndefined(value.trim()) : value),
  z
    .string()
    .refine(isValidLicenceNo, 'Enter a valid licence number (at least 4 characters).')
    .optional(),
);

export const optionalMargCode = z.preprocess(
  (value) => (typeof value === 'string' ? blankToUndefined(value.trim().toUpperCase()) : value),
  z.string().max(30, 'A Marg party code is at most 30 characters.').optional(),
);

const confirmationsSchema = z
  .object({
    // "This mobile is on another firm — he runs both" (DEC-055).
    sharedMobile: z.boolean().optional(),
    // "This PAN sits inside another buyer's GSTIN — it is a different firm".
    panInsideGstin: z.boolean().optional(),
  })
  .strict()
  .optional();

const contactMobileSchema = z
  .string()
  .transform(normalizeMobile)
  .refine(isValidMobile, 'Enter a valid 10-digit mobile number.');

/**
 * Phase 3 — the staff "Register a buyer" form, validated for real (it used to
 * check only the mobile, which let registrations with no firm or GSTIN
 * through that approval then refused for ever — F2).
 */
export const staffRegisterBuyerSchema = z
  .object({
    mobile: contactMobileSchema,
    firm: z.string().trim().min(1, 'Enter the firm name.'),
    gstin: optionalGstin,
    pan: optionalPan,
    ownerName: optionalText,
    category: categorySchema,
    location: locationSchema,
    dealerships: registerBuyerSchema.shape.dealerships,
    licenceNo: optionalLicence,
    margPartyCode: optionalMargCode,
    // null / absent = the Queue. Defaults to the person registering, if he
    // is on the Sales side (DEC-062).
    assignedToEmployeeId: objectId('the Sales person').nullable().optional(),
    bankDetail: bankDetailInputSchema.optional(),
    consent: consentInputSchema,
    callNote: optionalText,
    // DEC-056 — no OTP; the staff member confirms the proprietor agreed.
    proprietorAgreed: z.literal(true, {
      message: 'Tick that the proprietor agreed to register this number.',
    }),
    confirmations: confirmationsSchema,
  })
  .strict()
  .superRefine(refinePanMatchesGstin);

/** Phase 3 — Edit on the buyer profile. Who may change what is checked in the service. */
export const updateBuyerSchema = z
  .object({
    firm: z.string().trim().min(1, 'Enter the firm name.'),
    ownerName: optionalText,
    contactMobile: contactMobileSchema,
    gstin: optionalGstin,
    pan: optionalPan,
    category: categorySchema,
    location: locationSchema,
    dealerships: registerBuyerSchema.shape.dealerships,
    licenceNo: optionalLicence,
    margPartyCode: optionalMargCode,
    confirmations: confirmationsSchema,
  })
  .strict()
  .superRefine(refinePanMatchesGstin);

// Phase 4 — the staff "Add a seller" form: everything the seller app asks,
// plus his location (mandatory), Assigned to, Marg party code, and the
// proprietor-agreed tick that replaces the OTP wait (DEC-056). GSTIN stays
// mandatory for a seller — TriFid buys on a GST invoice.
export const staffRegisterSellerSchema = registerSellerSchema.extend({
  callNote: z.string().min(1, 'A call note is required for a staff-assisted registration.'),
  location: locationSchema,
  margPartyCode: optionalMargCode,
  assignedToEmployeeId: objectId('the Purchase person').nullable().optional(),
  proprietorAgreed: z.literal(true, {
    message: 'Tick that the proprietor agreed to register this number.',
  }),
});

/** Phase 4 — Edit on the seller profile. GSTIN stays mandatory; only Admin changes it. */
export const updateSellerSchema = z
  .object({
    firm: z.string().trim().min(1, 'Enter the firm name.'),
    ownerName: z.string().trim().min(1, 'Enter the proprietor name.'),
    contactMobile: contactMobileSchema,
    gstin: gstinSchema,
    licenceNo: licenceNoSchema,
    location: locationSchema,
    margPartyCode: optionalMargCode,
  })
  .strict();

export const listRegistrationsQuerySchema = z
  .object({
    stage: z.enum(['pending', 'active', 'rejected']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    // 26 Oct — firm name, GSTIN, PAN or mobile; part of it is enough.
    q: z.string().trim().max(80).optional(),
    // 29 Oct — only buyers or only sellers (the "Waiting" lists and their counts).
    kind: z.enum(['buyer', 'seller']).optional(),
  })
  .strict();

// Phase 3 — prefilled from the registration, every field editable by the
// approver. Category replaces position + "Is trader" (DEC-058); "Assigned
// to" is mandatory (DEC-062).
export const approveBuyerSchema = z
  .object({
    category: categorySchema,
    location: locationSchema,
    assignedToEmployeeId: objectId('the Sales person this buyer is assigned to'),
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
    // Phase 4 — the approver may change his location (required when the
    // registration came without one, e.g. from the seller app) and must name
    // who he is assigned to (DEC-062).
    location: locationSchema.optional(),
    assignedToEmployeeId: objectId('the Purchase person this seller is assigned to'),
  })
  .strict();

export const rejectRegistrationSchema = z
  .object({
    reason: z.string().min(1, 'A reason is required to reject a registration.'),
  })
  .strict();

export const bankDetailChangeSchema = bankDetailInputSchema;
