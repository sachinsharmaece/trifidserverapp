import { z } from 'zod';

// BR-033/CH §22.9 — no override field exists on this schema, for any role.
export const keyMargInvoiceSchema = z
  .object({
    margInvoiceNo: z.string().min(1),
    date: z.coerce.date(),
    valuePaise: z.number().int().positive(),
    ewayNo: z.string().min(1),
  })
  .strict();
