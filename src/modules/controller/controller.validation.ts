import { z } from 'zod';
import { COMPLAINT_DISPOSITIONS } from '../../models/Complaint.js';

export const decideDisputeSchema = z
  .object({
    disposition: z.enum(COMPLAINT_DISPOSITIONS),
    note: z.string().min(1),
    debitValuePaise: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.disposition !== 'seller_fault' || typeof v.debitValuePaise === 'number', {
    message: 'debitValuePaise is required when disposition is seller_fault.',
    path: ['debitValuePaise'],
  });

export const bulkLifelineSchema = z
  .object({
    extensionHours: z.number().positive(),
    reason: z.string().min(1),
    checkerEmployeeId: z.string().min(1),
  })
  .strict();
