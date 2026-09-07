import { z } from 'zod';

export const configUpdateSchema = z
  .object({
    value: z.unknown(),
  })
  .strict();

export const createEmployeeSchema = z
  .object({
    person: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    desk: z.string().optional(),
    roleKeys: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const listEmployeesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
