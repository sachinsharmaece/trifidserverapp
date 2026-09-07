import { z } from 'zod';

export const createFileSchema = z
  .object({
    mime: z.string().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
