import { z } from 'zod';
import { ENQUIRY_DROP_REASONS } from '../../models/Enquiry.js';
import { DELIVERY_BANDS, EXPIRY_BANDS } from '../../models/ListingLine.js';
import {
  ENQUIRY_KINDS,
  ENQUIRY_OUTCOMES,
  ENQUIRY_PARTIES,
  ENQUIRY_STATUSES,
} from './enquiry.status.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id.');
const callNote = z.string().trim().min(1);
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const conditionRequirement = z
  .object({
    expiryBand: z.enum(EXPIRY_BANDS),
    deliveryBand: z.enum(DELIVERY_BANDS).optional(),
  })
  .strict();
const prospect = z
  .object({
    firm: z.string().trim().min(1).max(120),
    contactName: z.string().trim().min(1).max(120).optional(),
    mobile: z
      .string()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.')
      .optional(),
    place: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const listEnquiriesQuerySchema = z
  .object({
    kind: z.enum(ENQUIRY_KINDS).optional(),
    outcome: z.enum(ENQUIRY_OUTCOMES).optional(),
    status: z.enum(ENQUIRY_STATUSES).optional(),
    mine: flag.optional(),
    followUpDue: flag.optional(),
    q: z.string().trim().min(1).max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const enquiryIdParamsSchema = z.object({ id: objectId });

// BR-121 — `.strict()` refuses a price field here exactly as API-040 does.
// `party` (default `buyer`) picks whose lead this is (DEC-052) — a buyer
// counterparty/prospect, or a seller counterparty/prospect, never both.
export const createEnquirySchema = z
  .object({
    party: z.enum(ENQUIRY_PARTIES).default('buyer'),
    buyerCounterpartyId: objectId.optional(),
    sellerCounterpartyId: objectId.optional(),
    prospect: prospect.optional(),
    skuId: objectId.optional(),
    productText: z.string().trim().min(1).max(200).optional(),
    qty: z.number().int().min(1),
    conditionRequirement: conditionRequirement.optional(),
    callNote,
  })
  .strict()
  .superRefine((v, ctx) => {
    const counterpartyId = v.party === 'buyer' ? v.buyerCounterpartyId : v.sellerCounterpartyId;
    const otherField = v.party === 'buyer' ? 'sellerCounterpartyId' : 'buyerCounterpartyId';
    if (v[otherField]) {
      ctx.addIssue({
        code: 'custom',
        message: `party is "${v.party}" — do not also give ${otherField}.`,
        path: [otherField],
      });
    }
    if (!!counterpartyId === !!v.prospect) {
      ctx.addIssue({
        code: 'custom',
        message: `Give either a registered ${v.party} or a prospect, not both.`,
        path: [v.party === 'buyer' ? 'buyerCounterpartyId' : 'sellerCounterpartyId'],
      });
    }
    if (!v.skuId && !v.productText) {
      ctx.addIssue({
        code: 'custom',
        message: 'Give a catalogue pack or describe the product.',
        path: ['skuId'],
      });
    }
  });

// DEC-052 — pre-trade only: the still-draft descriptive fields. Identity
// (buyer/seller/prospect, catalogue pack) changes by converting, not editing.
export const editEnquirySchema = z
  .object({
    qty: z.number().int().min(1).optional(),
    conditionRequirement: conditionRequirement.optional(),
    prospect: prospect.optional(),
    productText: z.string().trim().min(1).max(200).optional(),
    callNote,
  })
  .strict();

export const convertEnquirySchema = z
  .object({
    buyerCounterpartyId: objectId,
    skuId: objectId,
    qty: z.number().int().min(1).optional(),
    conditionRequirement,
    callNote,
  })
  .strict();

export const dropEnquirySchema = z
  .object({ reason: z.enum(ENQUIRY_DROP_REASONS), callNote })
  .strict();

// DEC-052 — a seller pre-trade enquiry's other exit: Purchase made a listing
// for him separately (no automatic link to it — see enquiry.status.ts).
export const markListedSchema = z.object({ callNote }).strict();

const workDesk = z.enum(['sales', 'purchase']);

export const setOwnerSchema = z
  .object({ desk: workDesk.optional(), employeeId: objectId.nullable() })
  .strict();

export const setFollowUpSchema = z
  .object({ desk: workDesk.optional(), at: z.coerce.date().nullable() })
  .strict();

export const addNoteSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();

export const assigneesQuerySchema = z.object({ desk: workDesk }).strict();
