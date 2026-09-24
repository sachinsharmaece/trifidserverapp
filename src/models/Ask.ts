import { Schema, model, type InferSchemaType } from 'mongoose';
import { DELIVERY_BANDS, EXPIRY_BANDS } from './ListingLine.js';
import { proxyLogField } from '../shared/proxyLog.js';

/**
 * ENT-19 `ask`. BR-064/`CH §3.12` — **there is no `tehsil` and no `district`
 * field here, and there never will be.** A build-failing sweep
 * (tests/wallSweep.test.ts) checks every seller-facing ask projection for a
 * town name.
 *
 * BR-121 — the buyer states no price; there is no `ratePaise` field on this
 * schema at all, so there is nothing for a client to smuggle a price into.
 */
export const ASK_STATES = ['open', 'quoted', 'converted', 'lapsed', 'withdrawn'] as const;
export type AskState = (typeof ASK_STATES)[number];

const askSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'Sku', default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    allPacks: { type: Boolean, required: true, default: false },
    qty: { type: Number, required: true, min: 1 },
    conditionRequirement: {
      expiryBand: { type: String, enum: EXPIRY_BANDS, required: true },
      deliveryBand: { type: String, enum: DELIVERY_BANDS, default: null },
    },
    visibleToAllAt: { type: Date, required: true }, // BR-122 — the 4-working-hour head start ends here.
    // M8 — set once the head start has been closed out: at creation when there was
    // no head start to wait for, otherwise by the 5-minute head-start job.
    // `null` means "still inside the head start". Visibility itself is computed
    // from `visibleToAllAt`; this only records that the transition happened.
    headStartOpenedAt: { type: Date, default: null },
    ttlAt: { type: Date, required: true }, // BR-120 — 30-day Open Demand TTL.
    state: { type: String, enum: ASK_STATES, required: true, default: 'open' },
    holdExpiresAt: { type: Date, default: null }, // BR-126 — starts at the first quote, never restarts.
    // Staff-assisted enquiries — present only when Sales raised or advanced
    // this ask on a phone call. See shared/proxyLog.ts.
    proxyLog: proxyLogField,
    // DEC-051 — the enquiry this ask is. Set at creation (or when a pre-trade
    // enquiry converts); null only on asks raised before the enquiry record existed.
    enquiryId: { type: Schema.Types.ObjectId, ref: 'Enquiry', default: null },
  },
  { timestamps: true },
);

askSchema.index({ state: 1, ttlAt: 1 });
askSchema.index({ buyerId: 1, state: 1 });
askSchema.index({ skuId: 1, state: 1 });

export type AskDocument = InferSchemaType<typeof askSchema>;
export const Ask = model<AskDocument>('Ask', askSchema, 'ask');
