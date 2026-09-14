import { z } from 'zod';
import { DELIVERY_BANDS, EXPIRY_BANDS, PROVENANCE_VALUES } from '../../models/ListingLine.js';

export const raiseAskSchema = z
  .object({
    skuId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    allPacks: z.boolean().default(false),
    qty: z.number().int().min(1),
    conditionRequirement: z
      .object({
        expiryBand: z.enum(EXPIRY_BANDS),
        deliveryBand: z.enum(DELIVERY_BANDS).optional(),
      })
      .strict(),
  })
  // BR-121 — the buyer states no price. `.strict()` already rejects any
  // unrecognised key outright (a `price`/`ratePaise` field included), rather
  // than silently dropping it.
  .strict();

export const acceptAskFillSchema = z
  .object({
    option: z.enum(['partial', 'full']),
    quoteIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const postQuoteSchema = z
  .object({
    ratePaiseForIndore: z.number().int().positive(),
    qtyAvailable: z.number().int().min(1),
    expiryBand: z.enum(EXPIRY_BANDS),
    expiryExact: z.string().regex(/^(0[1-9]|1[0-2])\/\d{4}$/),
    deliveryBand: z.enum(DELIVERY_BANDS),
    provenance: z.enum(PROVENANCE_VALUES),
    batch: z.string().min(1).optional(),
    daysToIndore: z.number().int().min(0),
  })
  .strict();

export const confirmPileSchema = z
  .object({
    canSendBoxes: z.number().int().min(0),
    expiryExact: z.string().regex(/^(0[1-9]|1[0-2])\/\d{4}$/),
    batch: z.string().min(1).optional(),
  })
  .strict();
