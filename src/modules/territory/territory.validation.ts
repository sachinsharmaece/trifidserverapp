import { z } from 'zod';

export const createTehsilSchema = z
  .object({
    name: z.string().min(1),
    district: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();

export const listTehsilsQuerySchema = z
  .object({
    district: z.string().optional(),
  })
  .strict();
