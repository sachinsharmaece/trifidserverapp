import { z } from 'zod';

export const setMarginMatrixCellSchema = z
  .object({
    class: z.enum(['High', 'Medium', 'Low']),
    tier: z.enum(['Distributor', 'Dealer', 'Retailer', 'Trader']),
    pct: z.number().min(0).max(1),
    creditPct: z.number().min(0).max(1).optional(),
    effectiveFrom: z.coerce.date(),
  })
  .strict();
