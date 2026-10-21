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
// Buyer file stage buttons — every one carries the call note, like the proxy endpoints.
const stageCallNote = z.string().trim().min(1);
export const giveRateSchema = z
    .object({ listingLineId: z.string().min(1), callNote: stageCallNote })
    .strict();
/** Sales giving the asking buyer a quote that has been parked for him. */
export const giveParkedQuoteSchema = z.object({ callNote: stageCallNote }).strict();
export const markPaidSchema = z
    .object({ utr: z.string().trim().min(6).max(40), callNote: stageCallNote })
    .strict();
export const cancelOrderSchema = z.object({ callNote: stageCallNote }).strict();
export const markDeliveredSchema = cancelOrderSchema;
export const markBilledSchema = z
    .object({
    margInvoiceNo: z.string().trim().min(1),
    date: z.coerce.date(),
    valuePaise: z.number().int().positive(),
    ewayNo: z.string().trim().min(1),
    callNote: stageCallNote,
})
    .strict();
export const skipToBilledSchema = markBilledSchema
    .extend({ legOneRef: z.string().trim().min(1).optional() })
    .strict();
// The leg 2 dispatch form — the same rules as the Logistics desk's movement record (BR-176).
export const dispatchOrderSchema = z
    .object({
    mode: z.enum(['transport', 'bus']),
    transporter: z.string().trim().min(1).optional(),
    lr: z.string().trim().min(1).optional(),
    busNo: z.string().trim().min(1).optional(),
    driver: z.string().trim().min(1).optional(),
    driverMobile: z.string().trim().min(1).optional(),
    freightTerms: z.enum(['prepaid', 'to_pay']),
    freightAmountPaise: z.number().int().min(0),
    callNote: stageCallNote,
})
    .strict()
    .refine((value) => value.mode !== 'transport' || !!value.lr, {
    message: 'LR number is mandatory on transport mode (BR-176).',
    path: ['lr'],
})
    .refine((value) => value.mode !== 'bus' || (!!value.busNo && !!value.driver && !!value.driverMobile), {
    message: 'Bus number, driver name and driver mobile are required on bus mode (BR-176).',
    path: ['busNo'],
});
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
