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
// API-132 — up to the twelve cells, one shared `effectiveFrom`.
export const setMarginMatrixBulkSchema = z
    .object({
    cells: z
        .array(z
        .object({
        class: z.enum(['High', 'Medium', 'Low']),
        tier: z.enum(['Distributor', 'Dealer', 'Retailer', 'Trader']),
        pct: z.number().min(0).max(1),
        creditPct: z.number().min(0).max(1).optional(),
    })
        .strict())
        .min(1)
        .max(12),
    effectiveFrom: z.coerce.date(),
})
    .strict();
