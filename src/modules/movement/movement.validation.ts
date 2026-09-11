import { z } from 'zod';

// BR-176 — LR mandatory on transport mode; bus mode needs bus/driver details instead.
export const recordMovementSchema = z
  .object({
    leg: z.union([z.literal(1), z.literal(2)]),
    mode: z.enum(['transport', 'bus']),
    transporter: z.string().optional(),
    lr: z.string().optional(),
    busNo: z.string().optional(),
    driver: z.string().optional(),
    driverMobile: z.string().optional(),
    photoRef: z.string().optional(),
    freightTerms: z.enum(['prepaid', 'to_pay']),
    freightAmountPaise: z.number().int().min(0),
  })
  .strict()
  .refine((value) => value.mode !== 'transport' || !!value.lr, {
    message: 'LR number is mandatory on transport mode (BR-176).',
    path: ['lr'],
  })
  .refine(
    (value) => value.mode !== 'bus' || (!!value.busNo && !!value.driver && !!value.driverMobile),
    {
      message: 'Bus number, driver name and driver mobile are required on bus mode (BR-176).',
      path: ['busNo'],
    },
  );
