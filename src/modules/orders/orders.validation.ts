import { z } from 'zod';
import { COMPLAINT_CATEGORIES } from '../../models/Complaint.js';

// API-075. BR-176 — two dispatch modes; LR mandatory on transport, optional on bus.
export const dispatchLeg1Schema = z
  .object({
    mode: z.enum(['transport', 'bus']),
    transporter: z.string().min(1).optional(),
    lr: z.string().min(1).optional(),
    busNo: z.string().min(1).optional(),
    driver: z.string().min(1).optional(),
    driverMobile: z.string().min(1).optional(),
    photoRef: z.string().min(1).optional(),
    freightTerms: z.enum(['prepaid', 'to_pay']),
    freightAmountPaise: z.number().int().min(0),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.mode === 'transport') {
      if (!input.transporter) {
        ctx.addIssue({
          code: 'custom',
          path: ['transporter'],
          message: 'Transporter is required.',
        });
      }
      if (!input.lr) {
        ctx.addIssue({ code: 'custom', path: ['lr'], message: 'LR number is required (BR-176).' });
      }
    } else {
      if (!input.busNo) {
        ctx.addIssue({ code: 'custom', path: ['busNo'], message: 'Bus number is required.' });
      }
      if (!input.driver) {
        ctx.addIssue({ code: 'custom', path: ['driver'], message: 'Driver name is required.' });
      }
      if (!input.driverMobile) {
        ctx.addIssue({
          code: 'custom',
          path: ['driverMobile'],
          message: 'Driver mobile is required.',
        });
      }
      if (!input.photoRef) {
        ctx.addIssue({ code: 'custom', path: ['photoRef'], message: 'A photo is required.' });
      }
    }
  });

// API-076.
export const extensionRequestSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

// API-074. BR-201 — five fixed categories, nothing free-form driving the outcome.
export const postComplaintSchema = z
  .object({
    category: z.enum(COMPLAINT_CATEGORIES),
    note: z.string().max(2000).optional(),
  })
  .strict();
