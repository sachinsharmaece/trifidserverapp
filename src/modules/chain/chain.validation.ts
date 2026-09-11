import { z } from 'zod';
import { RATE_OVERRIDE_REASON_CODES } from '../../models/RateOverride.js';

export const createSoSchema = z
  .object({
    buyerId: z.string().min(1),
    sellerId: z.string().min(1),
    skuId: z.string().min(1),
    boxes: z.number().int().min(1),
    sellerNetPaise: z.number().int().positive(),
    placeOfSupply: z.enum(['intra_state', 'inter_state']),
    overrideRatePaise: z.number().int().positive().optional(),
    overrideReasonCode: z.enum(RATE_OVERRIDE_REASON_CODES).optional(),
  })
  .strict();

export const editPoSchema = z
  .object({
    field: z.enum(['rate', 'qty']),
    to: z.number().positive(),
    reason: z.string().min(1),
  })
  .strict();

export const reduceSoQuantitySchema = z
  .object({
    newBoxes: z.number().int().min(0),
    reason: z.string().min(1),
    inspectionId: z.string().min(1),
  })
  .strict();
