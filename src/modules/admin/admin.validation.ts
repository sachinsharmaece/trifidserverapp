import { z } from 'zod';
import { EDUCATION_LEVELS, POSITIONS } from '../../config/positions.js';
import {
  isValidAadhaar,
  isValidMobile,
  isValidPan,
  normalizeMobile,
} from '../../shared/validators.js';

export const configUpdateSchema = z
  .object({
    value: z.unknown(),
  })
  .strict();

// Phase 2 — every message is written for the person filling the form in, and
// every refinement names its field, so the form puts it next to that field.
const objectId = (what: string) =>
  z.string().regex(/^[a-f0-9]{24}$/i, `Pick ${what} from the list.`);

const mobile = (label: string) =>
  z
    .string()
    .transform(normalizeMobile)
    .refine(isValidMobile, `Enter ${label} as a 10-digit mobile number starting 6–9.`);

const optionalMobile = (label: string) =>
  z
    .string()
    .transform((value) => (value.trim() === '' ? null : normalizeMobile(value)))
    .refine((value) => value === null || isValidMobile(value), {
      message: `Enter ${label} as a 10-digit mobile number starting 6–9, or leave it blank.`,
    })
    .nullable()
    .optional();

const optionalText = z
  .string()
  .transform((value) => (value.trim() === '' ? null : value.trim()))
  .nullable()
  .optional();

const panInput = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => isValidPan(value, { personOnly: true }), {
    message:
      "Enter the PAN as 5 letters, 4 digits, 1 letter — an employee's PAN has P as its 4th letter.",
  });

const aadhaarInput = z
  .string()
  .transform((value) => value.replace(/\s/g, ''))
  .refine(isValidAadhaar, {
    message: 'That Aadhaar number does not check out — 12 digits, not starting with 0 or 1.',
  });

function isAtLeast18(dob: string, today = new Date()): boolean {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const eighteenth = new Date(Date.UTC(y + 18, m - 1, d));
  return eighteenth.getTime() <= today.getTime();
}

const hrFields = {
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth.')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a real date of birth.')
    .refine((value) => isAtLeast18(value), 'An employee must be at least 18 years old.'),
  fatherName: z.string().trim().min(2, "Enter the father's name."),
  fatherMobile: optionalMobile("the father's mobile"),
  husbandName: optionalText,
  husbandMobile: optionalMobile("the husband's mobile"),
  emergencyContact: z
    .object({
      name: z.string().trim().min(2, 'Enter the emergency contact name.'),
      relation: z.string().trim().min(2, 'Enter how they are related.'),
      mobile: mobile('the emergency contact mobile'),
    })
    .strict(),
  permanentAddress: z.string().trim().min(5, 'Enter the permanent address.'),
  currentSameAsPermanent: z.boolean(),
  currentAddress: z.string().optional(),
  education: z
    .object({
      level: z.enum(EDUCATION_LEVELS, { message: 'Pick the highest education.' }).nullable(),
      other: optionalText,
    })
    .strict()
    .optional(),
};

function refineHr(
  hr: {
    currentSameAsPermanent: boolean;
    currentAddress?: string;
    education?: { level: string | null; other?: string | null };
  },
  ctx: z.RefinementCtx,
): void {
  if (!hr.currentSameAsPermanent && (hr.currentAddress ?? '').trim().length < 5) {
    ctx.addIssue({
      code: 'custom',
      path: ['currentAddress'],
      message: 'Enter the current local address, or tick "Same as permanent".',
    });
  }
  if (hr.education?.level === 'other' && !hr.education.other) {
    ctx.addIssue({
      code: 'custom',
      path: ['education', 'other'],
      message: 'Say what the education is.',
    });
  }
}

const createHrSchema = z
  .object({ ...hrFields, pan: panInput, aadhaar: aadhaarInput })
  .strict()
  .superRefine(refineHr);

// On edit, PAN and Aadhaar left out keep what is stored (the form only ever
// shows them masked); everything else is required again.
const updateHrSchema = z
  .object({ ...hrFields, pan: panInput.optional(), aadhaar: aadhaarInput.optional() })
  .strict()
  .superRefine(refineHr);

const teamFields = {
  person: z.string().trim().min(2, 'Enter the name.'),
  email: z.string().trim().email('Enter a valid email address.'),
  mobile: mobile('the mobile'),
  desk: z.string().optional(),
  // Positions add their own role on save, so an employee with only a
  // position may arrive with no role ticked; the service checks the result.
  roleKeys: z.array(z.string().min(1)),
  positions: z.array(z.enum(POSITIONS)).default([]),
  // A leader who is also an executive may report to himself: 'self'.
  reportsToSalesLeaderId: objectId('the Sales Leader').or(z.literal('self')).nullable().optional(),
  reportsToPurchaseLeaderId: objectId('the Purchase Leader')
    .or(z.literal('self'))
    .nullable()
    .optional(),
  worksForTeamLeaderIds: z.array(objectId('a team')).optional(),
  worksForAllTeams: z.boolean().optional(),
};

export const createEmployeeSchema = z
  .object({
    ...teamFields,
    // BR-262 — the lanes this new hire will hold. Optional because most
    // roles (Sales, Accounts, Transport & Logistics) hold no lane at all;
    // the save still fails if the board as a whole is not fully covered
    // once this employee's lanes are added. Not editable afterwards: a lane
    // moves with a deactivation's reassignment, never by dropping it.
    laneKeys: z.array(z.string().min(1)).optional(),
    password: z.string().min(8, 'Enter a password of at least 8 characters.'),
    hr: createHrSchema,
  })
  .strict();

// Edit — a blank (or absent) password keeps the current one.
export const updateEmployeeSchema = z
  .object({
    ...teamFields,
    password: z
      .string()
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
    hr: updateHrSchema,
  })
  .strict();

export const deactivateEmployeeSchema = z
  .object({
    reassignToEmployeeId: objectId('who takes over').optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const revealPiiSchema = z.object({ field: z.enum(['pan', 'aadhaar']) }).strict();

export const listEmployeesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    // Phase 2 — the Team list's Active / Inactive / All filter. Every
    // assign and reports-to dropdown asks for `active`.
    status: z.enum(['active', 'inactive', 'all']).optional(),
  })
  .strict();

export const assignBookSchema = z
  .object({
    buyerId: z.string().min(1),
    ownerEmployeeId: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

export const createAbsenceSchema = z
  .object({
    employeeId: z.string().min(1),
    from: z.coerce.date(),
    returnDate: z.coerce.date(),
    coveredBy: z.string().min(1),
  })
  .strict();
