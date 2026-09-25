import { z } from 'zod';
import { SUPPLY_GAP_CODES } from '../../../models/NonOrderReason.js';

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
    hsn: z.string().min(1),
    class: z.enum(['A', 'B', 'C']).optional(),
  })
  .strict();

export const draftSkuSchema = z
  .object({
    productId: z.string().min(1),
    packLabel: z.string().min(1),
    packSize: z.number().positive(),
    baseUnit: z.enum(['LTR', 'KG', 'PC']),
    unitsPerBox: z.number().int().positive(),
  })
  .strict();
