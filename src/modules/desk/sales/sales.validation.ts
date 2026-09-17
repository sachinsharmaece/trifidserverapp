import { z } from 'zod';
import { MSP_REFUSAL_CODES } from '../../../models/MspRequest.js';

export const requestMspSchema = z
  .object({
    skuId: z.string().min(1),
    qty: z.number().int().min(1),
    note: z.string().optional(),
  })
  .strict();

export const respondToMspSchema = z
  .object({
    granted: z.boolean(),
    refusalCode: z.enum(MSP_REFUSAL_CODES).optional(),
  })
  .strict();
