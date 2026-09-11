import { z } from 'zod';
import { INSPECTION_REJECTION_REASON_CODES } from '../../models/Inspection.js';

export const recordInspectionSchema = z
  .object({
    casesAccepted: z.number().int().min(0),
    casesRejected: z.number().int().min(0),
    reasons: z.array(z.enum(INSPECTION_REJECTION_REASON_CODES)).default([]),
    photoRefs: z.array(z.string()).min(1),
  })
  .strict();
