import { z } from 'zod';
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Pick a person from the list.');
/** Exactly one of GSTIN, PAN or mobile — an exact match, never a search (DEC-060). */
export const leadLookupQuerySchema = z
    .object({
    gstin: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[0-9A-Z]{15}$/, 'Enter the full 15-character GSTIN.')
        .optional(),
    pan: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter the full 10-character PAN.')
        .optional(),
    mobile: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, 'Enter the full 10-digit mobile number.')
        .optional(),
})
    .strict()
    .superRefine((value, ctx) => {
    const given = [value.gstin, value.pan, value.mobile].filter(Boolean).length;
    if (given !== 1) {
        ctx.addIssue({
            code: 'custom',
            message: 'Look up by one of GSTIN, PAN or mobile.',
            path: ['gstin'],
        });
    }
});
/** `null` puts him back in the Queue. */
export const changeOwnerSchema = z
    .object({
    ownerEmployeeId: objectId.nullable(),
    note: z.string().trim().max(500).optional(),
})
    .strict();
