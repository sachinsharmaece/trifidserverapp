import { z } from 'zod';
import { MSP_REFUSAL_CODES } from '../../../models/MspRequest.js';
import { CALL_OUTCOMES, CALL_LOG_KINDS, CALL_LOG_UPDATE_KINDS } from '../../../models/CallLog.js';

export const requestMspSchema = z
  .object({
    skuId: z.string().min(1),
    qty: z.number().int().min(1),
    note: z.string().optional(),
  })
  .strict();

export const respondToMspSchema = z
  .object({
    granted: z.boolean(),
    refusalCode: z.enum(MSP_REFUSAL_CODES).optional(),
  })
  .strict();

// A `call` names how it went and which way it ran; an `update_request` names
// which field is changing. Enforced here (the request shape) and re-checked
// in sales.calls.ts's `createCallLog` (see that file for why).
export const createCallLogSchema = z
  .object({
    buyerId: z.string().min(1),
    direction: z.enum(['in', 'out']).nullable().optional(),
    kind: z.enum(CALL_LOG_KINDS),
    outcome: z.enum(CALL_OUTCOMES).optional(),
    note: z.string().min(1),
    producedAskId: z.string().optional(),
    listingLineId: z.string().optional(),
    updateKind: z.enum(CALL_LOG_UPDATE_KINDS).optional(),
    updateValue: z.string().optional(),
    promiseDueAt: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === 'call' && (!val.outcome || !val.direction)) {
      ctx.addIssue({
        code: 'custom',
        message: 'A call log requires an outcome and which way the call ran.',
        path: ['outcome'],
      });
    }
    if (val.kind === 'update_request' && !val.updateKind) {
      ctx.addIssue({
        code: 'custom',
        message: 'An update request must say which field is changing.',
        path: ['updateKind'],
      });
    }
  });
