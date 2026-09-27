import { z } from 'zod';
import { SUPPLY_GAP_CODES } from '../../../models/NonOrderReason.js';
import { isValidHsn, packLabelMatchesBaseUnit } from '../../../shared/validators.js';

export const nonOrderReasonSchema = z
  .object({
    askId: z.string().optional(),
    pileId: z.string().optional(),
    code: z.enum(SUPPLY_GAP_CODES),
  })
  .strict()
  .refine((v) => !!v.askId || !!v.pileId, {
    message: 'Either askId or pileId is required.',
  });

// ---------------------------------------------------------------------------
// Purchase-desk v2.
// ---------------------------------------------------------------------------

export const sellerCatalogueEntrySchema = z
  .object({
    sellerId: z.string().min(1),
    productId: z.string().min(1),
    skuIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const draftManufacturerSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export const draftProductSchema = z
  .object({
    brand: z.string().min(1),
    technical: z.string().min(1),
    manufacturerId: z.string().min(1),
    hsn: z
      .string()
      .min(1)
      .refine(isValidHsn, { message: 'HSN must be 6 or 8 digits starting with 3808.' }),
    class: z.enum(['A', 'B', 'C']).optional(),
  })
  .strict();

export const draftSkuSchema = z
  .object({
    productId: z.string().min(1),
    packLabel: z.string().min(1),
    packSize: z.number().positive({ message: 'Pack size must be a positive number.' }),
    baseUnit: z.enum(['LTR', 'KG', 'PC']),
    unitsPerBox: z.number().int().positive({ message: 'Units per box must be a positive number.' }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!packLabelMatchesBaseUnit(v.packLabel, v.baseUnit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['packLabel'],
        message: `The pack "${v.packLabel}" does not look like a ${v.baseUnit} pack.`,
      });
    }
  });
