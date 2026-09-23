import { z } from 'zod';
import {
  raiseAskSchema,
  acceptAskFillSchema,
  confirmPileSchema,
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
