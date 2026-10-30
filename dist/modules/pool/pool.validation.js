import { z } from 'zod';
export const commitToPoolSchema = z
    .object({
    qty: z.number().int().min(1),
    // 29 Oct — optional: without one it goes to his primary location, else his registered address.
    deliveryLocationId: z.string().min(1).optional(),
})
    .strict();
export const poolsQuerySchema = z
    .object({
    skuIds: z.string().min(1), // comma-separated
})
    .strict();
export const resolvePoolShortfallSchema = z
    .object({
    sellerWillShipLowerQty: z.boolean(),
})
    .strict();
