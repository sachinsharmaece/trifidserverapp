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
    // BR-262 — the lanes this new hire will hold. Optional because most
    // roles (Sales, Accounts, Transport & Logistics) hold no lane at all;
    // the save still fails if the board as a whole is not fully covered
    // once this employee's lanes are added.
    laneKeys: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const listEmployeesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const assignBookSchema = z
  .object({
    buyerId: z.string().min(1),
    ownerEmployeeId: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

export const createAbsenceSchema = z
  .object({
    employeeId: z.string().min(1),
    from: z.coerce.date(),
    returnDate: z.coerce.date(),
    coveredBy: z.string().min(1),
  })
  .strict();
