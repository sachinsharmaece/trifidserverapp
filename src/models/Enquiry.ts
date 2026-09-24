import { Schema, model, type InferSchemaType } from 'mongoose';
import { DELIVERY_BANDS, EXPIRY_BANDS } from './ListingLine.js';
import {
  ENQUIRY_KINDS,
  ENQUIRY_OUTCOMES,
  ENQUIRY_PARTIES,
  ENQUIRY_PHASES,
  ENQUIRY_STATUSES,
  WAITING_ON,
} from '../modules/enquiry/enquiry.status.js';

/**
 * ENT-62 `enquiry` — DEC-051. The one record every desk works an enquiry
 * from, from the moment it is raised until it becomes an order.
 *
 * It is a PARENT over the trade mechanics, not a replacement for them: an
 * `ask` (WF-09) or a `pile_request` (WF-04/WF-05) still does all the work,
 * and points back here (`ask.enquiryId`, `pile_request.enquiryId`, and each
 * resulting `so.enquiryId`). A `pre_trade` enquiry (DEC-052) has neither yet.
 *
 * `status`/`phase`/`outcome`/`waitingOn` are STORED, but only ever written by
 * `syncEnquiry` (modules/enquiry/enquiry.sync.ts), inside the same transaction
 * as the ask/pile change it mirrors — never set directly by any other code.
 * The stored status stops at `ordered`; the chain carries the trade on.
 *
 * BR-064 — like `ask`, there is no tehsil or district field here. BR-121 —
 * no price field: the buyer states no price.
 *
 * `party` — whose lead this is (`buyer`, always for `ask`/`pile_request`;
 * `buyer` or `seller` for `pre_trade`, DEC-052's seller-side extension). See
 * `modules/enquiry/enquiry.status.ts` for the full explanation.
 */
// `sales_call` names the mechanism (a staff phone call), not the desk — it
// covers a Purchase call for a seller-party enquiry too (DEC-052); the admin
// UI picks the desk-appropriate label from `party`, not from this value.
export const ENQUIRY_CHANNELS = ['self', 'sales_call'] as const;
export type EnquiryChannel = (typeof ENQUIRY_CHANNELS)[number];

/** Which desk wrote a note or owns a follow-up. `full` is Controller/Admin/Accounts/Founder. */
export const ENQUIRY_DESKS = ['sales', 'purchase', 'full'] as const;
export type EnquiryDesk = (typeof ENQUIRY_DESKS)[number];

/** DEC-052 — the fixed reasons a pre-trade enquiry is dropped. Never free text alone. */
export const ENQUIRY_DROP_REASONS = [
  'buyer_not_registrable', // could not or would not register (GSTIN, licence…)
  'product_not_stocked', // not in the catalogue and not going to be
  'buyer_lost_interest',
  'duplicate',
  'other',
] as const;
export type EnquiryDropReason = (typeof ENQUIRY_DROP_REASONS)[number];

const enquirySchema = new Schema(
  {
    enquiryNo: { type: String, required: true, unique: true },
    kind: { type: String, enum: ENQUIRY_KINDS, required: true },
    channel: { type: String, enum: ENQUIRY_CHANNELS, required: true },
    raisedAt: { type: Date, required: true },
    // Staff member who logged it, when `channel` is a call. Null for self-service.
    raisedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },

    // Whose lead this is. Always `buyer` for `ask`/`pile_request` (only a
    // buyer raises either); a `pre_trade` enquiry may be either (DEC-052).
    party: { type: String, enum: ENQUIRY_PARTIES, required: true, default: 'buyer' },
    // The buyer side — a registered buyer, or (pre-trade, party `buyer`) a prospect.
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', default: null },
    // The seller side — pre-trade, party `seller` only: a registered seller,
    // or (unregistered) the same `prospect` shape below.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', default: null },
    prospect: {
      type: {
        firm: { type: String, required: true },
        contactName: { type: String, default: null },
        mobile: { type: String, default: null },
        place: { type: String, default: null },
      },
      default: null,
    },

    // What is asked for. A catalogue SKU/product, or — pre-trade only — free text.
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    productText: { type: String, default: null },
    qty: { type: Number, required: true, min: 1 },
    requirement: {
      type: {
        expiryBand: { type: String, enum: EXPIRY_BANDS, default: null },
        deliveryBand: { type: String, enum: DELIVERY_BANDS, default: null },
      },
      default: null,
    },

    // The trade mechanics this enquiry is. At most one; none while pre-trade.
    askId: { type: Schema.Types.ObjectId, ref: 'Ask', default: null },
    pileRequestId: { type: Schema.Types.ObjectId, ref: 'PileRequest', default: null },

    // Written only by syncEnquiry (and the pre-trade create/drop, which have no trade to read).
    status: { type: String, enum: ENQUIRY_STATUSES, required: true },
    phase: { type: String, enum: ENQUIRY_PHASES, required: true },
    outcome: { type: String, enum: ENQUIRY_OUTCOMES, required: true },
    waitingOn: { type: String, enum: WAITING_ON, default: null },
    statusChangedAt: { type: Date, required: true },

    // DEC-051 — one owner per desk (DEC-015: people own customers).
    owners: {
      sales: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
      purchase: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    },
    followUp: {
      sales: { type: Date, default: null },
      purchase: { type: Date, default: null },
    },
    // Desk-scoped: a note is read only by the desk that wrote it and the full
    // view — a Purchase note may name a seller, a Sales note the buyer (BR-060).
    notes: {
      type: [
        {
          desk: { type: String, enum: ENQUIRY_DESKS, required: true },
          authorId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
          text: { type: String, required: true },
          at: { type: Date, required: true, default: Date.now },
        },
      ],
      default: [],
    },

    dropReason: { type: String, enum: ENQUIRY_DROP_REASONS, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

enquirySchema.index({ raisedAt: -1 });
enquirySchema.index({ status: 1, raisedAt: -1 });
enquirySchema.index({ outcome: 1, raisedAt: -1 });
enquirySchema.index({ buyerId: 1, raisedAt: -1 });
enquirySchema.index({ sellerId: 1, raisedAt: -1 });
enquirySchema.index({ 'owners.sales': 1 });
enquirySchema.index({ 'owners.purchase': 1 });
enquirySchema.index({ 'followUp.sales': 1 });
enquirySchema.index({ 'followUp.purchase': 1 });
// One enquiry per ask and per pile request — the back-link is never ambiguous.
enquirySchema.index(
  { askId: 1 },
  { unique: true, partialFilterExpression: { askId: { $type: 'objectId' } } },
);
enquirySchema.index(
  { pileRequestId: 1 },
  { unique: true, partialFilterExpression: { pileRequestId: { $type: 'objectId' } } },
);

export type EnquiryDocument = InferSchemaType<typeof enquirySchema>;
export const Enquiry = model<EnquiryDocument>('Enquiry', enquirySchema, 'enquiry');
