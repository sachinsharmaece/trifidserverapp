import { z } from 'zod';

export const createTransporterSchema = z
  .object({
    name: z.string().min(1),
    mobile: z.string().min(1).optional(),
    vehicleType: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const createConsolidationSchema = z
  .object({
    movementIds: z.array(z.string().min(1)).min(2),
  })
  .strict();
