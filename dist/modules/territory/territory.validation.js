import { z } from 'zod';
const objectId = (what) => z.string().regex(/^[a-f0-9]{24}$/i, `Pick a ${what} from the list.`);
const pincode = z
    .string()
    .regex(/^[1-9]\d{5}$/, 'Enter a 6-digit pincode that does not start with 0.');
export const createStateSchema = z
    .object({
    name: z.string().trim().min(2, 'Enter the state name.'),
    gstStateCode: z.string().regex(/^\d{2}$/, 'Enter the 2-digit GST state code.'),
})
    .strict();
export const listDistrictsQuerySchema = z
    .object({ stateId: objectId('state').optional() })
    .strict();
export const createDistrictSchema = z
    .object({
    name: z.string().trim().min(2, 'Enter the district name.'),
    stateId: objectId('state'),
})
    .strict();
// Phase 1 — a tehsil is created under a District master, never from free
// text; the district and state names on the record are copied from it.
export const createTehsilSchema = z
    .object({
    name: z.string().trim().min(2, 'Enter the tehsil name.'),
    districtId: objectId('district'),
})
    .strict();
export const updateTehsilSchema = z
    .object({
    name: z.string().trim().min(2, 'Enter the tehsil name.').optional(),
    districtId: objectId('district').optional(),
})
    .strict()
    .refine((body) => body.name !== undefined || body.districtId !== undefined, {
    message: 'Change the name or the district.',
});
export const listTehsilsQuerySchema = z
    .object({
    district: z.string().optional(),
    districtId: objectId('district').optional(),
})
    .strict();
export const pincodeParamSchema = pincode;
export const listPincodesQuerySchema = z
    .object({ status: z.enum(['verified', 'unverified']).optional() })
    .strict();
export const updatePincodeSchema = z
    .object({
    tehsilId: objectId('tehsil').optional(),
    verify: z.literal(true).optional(),
})
    .strict()
    .refine((body) => body.tehsilId !== undefined || body.verify !== undefined, {
    message: 'Change the tehsil or mark it verified.',
});
