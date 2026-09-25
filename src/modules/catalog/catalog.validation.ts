import { z } from 'zod';

export const createManufacturerSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export const listManufacturersQuerySchema = z
  .object({
    technical: z.string().min(1),
  })
  .strict();

export const listProductsQuerySchema = z
  .object({
    technical: z.string().min(1),
    manufacturer: z.string().optional(),
  })
  .strict();

// New — the admin catalog-management screen's own unfiltered list. BR-111
// ("technical is the primary axis") governs the counterparty-facing picker
// (feed, pools, raising an ask); it says nothing about the staff data-
// management screen, which already lists every registration/employee/etc.
// without a mandatory filter elsewhere in this contract.
export const listAllProductsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const createProductSchema = z
  .object({
    brand: z.string().min(1),
    technical: z.string().min(1),
    manufacturerId: z.string().min(1),
    hsn: z.string().min(1),
    class: z.enum(['A', 'B', 'C']).optional(),
  })
  .strict();

export const updateManufacturerSchema = z
  .object({
    name: z.string().min(1).optional(),
    // Purchase-desk v2 — Admin's confirm action. One direction only: there is
    // no path back to 'draft', so 'draft' is not an accepted value here.
    state: z.literal('live').optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    brand: z.string().min(1).optional(),
    technical: z.string().min(1).optional(),
    manufacturerId: z.string().min(1).optional(),
    hsn: z.string().min(1).optional(),
    class: z.enum(['A', 'B', 'C']).optional(),
    active: z.boolean().optional(),
    // Purchase-desk v2 — Admin's confirm action, same one-direction shape.
    state: z.literal('live').optional(),
  })
  .strict();

// New — the Manage desk's own SKU edit. `baseUnit` is deliberately not
// accepted here at all — BR-055, `models/Sku.ts`'s own `immutable: true`.
export const updateSkuSchema = z
  .object({
    packLabel: z.string().min(1).optional(),
    packSize: z.number().positive().optional(),
    unitsPerBox: z.number().int().positive().optional(),
    active: z.boolean().optional(),
    // Purchase-desk v2 — Admin's confirm action, same one-direction shape.
    state: z.literal('live').optional(),
  })
  .strict();

// Deliberately loose on packSize/unitsPerBox/baseUnit here (z.unknown()) —
// BR-055's rejection is about the *value* being wrong (not a positive
// number, or baseUnit not one of LTR/KG/PC), not the request shape being
// wrong, and the whole point of the import is to report that row-by-row
// rather than failing the request at the validation boundary.
export const skuImportRowSchema = z
  .object({
    packLabel: z.string().min(1),
    packSize: z.unknown(),
    baseUnit: z.unknown(),
    unitsPerBox: z.unknown(),
  })
  .strict();

export const skuImportSchema = z
  .object({
    productId: z.string().min(1),
    rows: z.array(skuImportRowSchema).min(1),
  })
  .strict();
