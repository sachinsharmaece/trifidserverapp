import { z } from 'zod';

export const disagreeSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();
