import { z } from 'zod';
import { isValidHsn } from '../../shared/validators.js';
import { PRODUCT_CATEGORIES } from '../../models/Hsn.js';

const HSN_MESSAGE = 'HSN must be 6 or 8 digits.';
const hsnField = z.string().min(1).refine(isValidHsn, { message: HSN_MESSAGE });
const taxPercentField = z
  .number()
  .min(0, { message: 'Tax % must be between 0 and 100.' })
  .max(100, { message: 'Tax % must be between 0 and 100.' });

// A pack as the admin types it: a size in a unit they choose. ML/GM are
// converted to the LTR/KG base unit server-side (BR-055 only knows LTR/KG/PC).
export const PACK_UNITS = ['LTR', 'ML', 'KG', 'GM', 'PC'] as const;
export const productPackSchema = z
  .object({
    packSize: z.number().positive({ message: 'Pack size must be a positive number.' }),
    unit: z.enum(PACK_UNITS),
    unitsPerBox: z.number().int().positive({ message: 'Units in box must be a positive number.' }),
  })
  .strict();

export const createTechnicalSchema = z.object({ name: z.string().trim().min(1) }).strict();

export const createHsnSchema = z
  .object({
    code: hsnField,
    description: z.string().trim().max(200).optional(),
    taxPercent: taxPercentField,
  })
  .strict();

export const createManufacturerSchema = z
  .object({
    name: z.string().min(1),
    aka: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const listManufacturersQuerySchema = z
  .object({
    technical: z.string().min(1),
  })
  .strict();

export const searchProductsQuerySchema = z
  .object({
    q: z.string().max(80).optional().default(''),
    limit: z.coerce.number().int().min(1).max(50).optional().default(50),
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
    // 29 Oct — part of the product, technical or company name.
    q: z.string().trim().max(80).optional(),
    // 29 Oct — only the soft-deleted products.
    deleted: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const createProductSchema = z
  .object({
    brand: z.string().min(1),
    technical: z.string().min(1),
    manufacturerId: z.string().min(1),
    hsn: hsnField,
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    taxPercent: taxPercentField.optional(),
    class: z.enum(['High', 'Medium', 'Low']).optional(),
    packs: z.array(productPackSchema).max(50).optional(),
  })
  .strict();

export const updateManufacturerSchema = z
  .object({
    name: z.string().min(1).optional(),
    aka: z.array(z.string().min(1)).optional(),
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
    hsn: hsnField.optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    taxPercent: taxPercentField.optional(),
    class: z.enum(['High', 'Medium', 'Low']).optional(),
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
    packSize: z.number().positive({ message: 'Pack size must be a positive number.' }).optional(),
    unitsPerBox: z
      .number()
      .int()
      .positive({ message: 'Units per box must be a positive number.' })
      .optional(),
    active: z.boolean().optional(),
    // Purchase-desk v2 — Admin's confirm action, same one-direction shape.
    state: z.literal('live').optional(),
    // 24 Oct — the unit the pack was entered in; `packSize` is then in it.
    unit: z.enum(PACK_UNITS).optional(),
  })
  .strict();

// 24 Oct — "Add pack" on an existing product, typed as on create.
export const addPacksSchema = z
  .object({ packs: z.array(productPackSchema).min(1, 'Add at least one pack.').max(50) })
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
