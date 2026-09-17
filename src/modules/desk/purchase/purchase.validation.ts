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
