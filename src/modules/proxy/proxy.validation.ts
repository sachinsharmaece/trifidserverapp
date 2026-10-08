import { z } from 'zod';
import {
  raiseAskSchema,
  acceptAskFillSchema,
  confirmPileSchema,
  postQuoteSchema,
} from '../demand/demand.validation.js';
import { createListingSchema } from '../listing/listing.validation.js';

const callNoteSchema = z.string().min(1);

// Every staff-assisted-enquiries proxy body carries the same two things on
// top of the counterparty-facing schema it extends: which counterparty this
// is being done on behalf of, and the mandatory one-line call note.
export const proxyRaiseAskSchema = raiseAskSchema.extend({
  buyerCounterpartyId: z.string().min(1),
  callNote: callNoteSchema,
});

// One call, several products: the same lines the single ask takes, one ask per line.
export const MAX_ASKS_PER_CALL = 20;
export const proxyRaiseAsksSchema = z
  .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
    lines: z.array(raiseAskSchema).min(1).max(MAX_ASKS_PER_CALL),
  })
  .strict();

export const proxyAcceptAskFillSchema = acceptAskFillSchema.extend({
  buyerCounterpartyId: z.string().min(1),
  callNote: callNoteSchema,
});

export const proxyDeclineAskSchema = z
  .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
  })
  .strict();

export const proxyPromotionDecisionSchema = z
  .object({
    buyerCounterpartyId: z.string().min(1),
    callNote: callNoteSchema,
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
