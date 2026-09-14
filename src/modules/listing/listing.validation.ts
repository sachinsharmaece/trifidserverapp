import { z } from 'zod';
import { LISTING_SCOPE_TYPES } from '../../models/Listing.js';
import { DELIVERY_BANDS, EXPIRY_BANDS, PROVENANCE_VALUES } from '../../models/ListingLine.js';

const createListingLineSchema = z
  .object({
    skuId: z.string().min(1),
    ratePaise: z.number().int().positive(),
    expiryBand: z.enum(EXPIRY_BANDS),
    expiryExact: z
      .string()
      .regex(/^(0[1-9]|1[0-2])\/\d{4}$/)
      .optional(),
    // BR-150 — the seller sets this directly; `moqBand` is derived from it
    // on the model, never accepted here.
    moqExact: z.number().int().min(1).optional(),
    deliveryBand: z.enum(DELIVERY_BANDS),
    provenance: z.enum(PROVENANCE_VALUES),
    batch: z.string().min(1).optional(),
    qty: z.number().int().min(1),
  })
  .strict();

export const createListingSchema = z
  .object({
    productId: z.string().min(1),
    scopeType: z.enum(LISTING_SCOPE_TYPES),
    customTehsilIds: z.array(z.string().min(1)).optional(),
    lines: z.array(createListingLineSchema).min(1),
  })
  .strict();

export const changeListingLineRateSchema = z
  .object({
    ratePaise: z.number().int().positive(),
    doubleConfirmed: z.boolean().optional(),
  })
  .strict();

export const listMyListingsQuerySchema = z
  .object({
    state: z.enum(['live', 'paused', 'withdrawn']).optional(),
  })
  .strict();

export const inquireSchema = z
  .object({
    qty: z.number().int().min(1),
    deliveryLocationId: z.string().min(1),
  })
  .strict();

export const feedQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
