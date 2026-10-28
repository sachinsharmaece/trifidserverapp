import { z } from 'zod';
import { raiseAskSchema, acceptAskFillSchema, confirmPileSchema, postQuoteSchema, } from '../demand/demand.validation.js';
import { createListingSchema } from '../listing/listing.validation.js';
const callNoteSchema = z.string().min(1);
// Every staff-assisted-enquiries proxy body carries the same two things on
// top of the counterparty-facing schema it extends: which counterparty this
// is being done on behalf of, and the mandatory one-line call note.
// What the buyer said he hopes to pay, noted by Sales. Only this staff-call schema accepts it;
// the buyer's own `raiseAskSchema` stays price-free (BR-121).
const expectedRatePaiseSchema = z.number().int().min(1).optional();
export const proxyRaiseAskSchema = raiseAskSchema.extend({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    // 28 Oct — Incoming/Outgoing, from the call page's toggle, for the call history.
    direction: z.enum(['in', 'out']).optional(),
    expectedRatePaise: expectedRatePaiseSchema,
});
// One call, several products: the same lines the single ask takes, one ask per line.
export const MAX_ASKS_PER_CALL = 20;
export const proxyRaiseAsksSchema = z
    .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    // 28 Oct — Incoming/Outgoing, from the call page's toggle, for the call history.
    direction: z.enum(['in', 'out']).optional(),
    lines: z
        .array(raiseAskSchema.extend({ expectedRatePaise: expectedRatePaiseSchema }))
        .min(1)
        .max(MAX_ASKS_PER_CALL),
})
    .strict();
export const proxyAcceptAskFillSchema = acceptAskFillSchema.extend({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    // 28 Oct — Incoming/Outgoing, from the call page's toggle, for the call history.
    direction: z.enum(['in', 'out']).optional(),
});
export const proxyDeclineAskSchema = z
    .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    // 28 Oct — Incoming/Outgoing, from the call page's toggle, for the call history.
    direction: z.enum(['in', 'out']).optional(),
})
    .strict();
export const proxyPromotionDecisionSchema = z
    .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    // 28 Oct — Incoming/Outgoing, from the call page's toggle, for the call history.
    direction: z.enum(['in', 'out']).optional(),
})
    .strict();
export const proxyCreateListingSchema = createListingSchema.extend({
    sellerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
});
export const proxyPostQuoteSchema = postQuoteSchema.extend({
    sellerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
});
export const proxyConfirmPileSchema = confirmPileSchema.extend({
    sellerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
});
export const proxyPileDecisionSchema = z
    .object({
    sellerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
})
    .strict();
// Read-side query for the Sales call workspace's ask/quote pickers — no
// call note, nothing is written.
export const proxyListBuyerAsksQuerySchema = z
    .object({
    buyerCounterpartyId: z.string().min(1),
})
    .strict();
