import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-27 `so`. ST-01 — the sales order's own state carries the fine-grained
 * chain position; `chain.stage` (models/Chain.ts) is the coarse strip.
 *
 * Q13 (6 Sep 2026) — transit insurance is dropped from launch scope.
 * `insuranceElected` / `insuranceDeclinedAt` / `coverNoteRef` are removed
 * entirely, not merely unused — DATA_MODEL.md ENT-27 listed them; see
 * CHANGELOG.md and DECISION_LOG.md for the superseding decision.
 *
 * `state` starts at `awaiting_payment`: this milestone's SO-creation entry
 * point (chain.service.ts `createSo`) is a deliberate, honestly-labelled
 * stand-in for WF-05's full seller-confirms-supply fan-out (piles, multiple
 * buyers, requote/decline) — that mechanism depends on the listing/pile
 * entities M5 builds. `draft` and `awaiting_seller_confirmation` therefore
 * have no producer yet and are kept in the enum for when M5 wires it in.
 */
export const SO_STATES = [
  'draft',
  'awaiting_seller_confirmation',
  'requote_offered',
  'awaiting_payment',
  'payment_verifying',
  'po_released',
  'dispatched_leg1',
  'at_indore',
  'inspected',
  'billed_in_marg',
  'dispatched_leg2',
  'delivered',
  'closed',
  'cancelled',
  'supply_failed',
  // New — M6, WF-11. A live, affordable replacement seller was found; the
  // buyer has 24h to accept or the SO resolves to `supply_failed` +
  // full refund on silence/reject (see modules/chain PromotionOffer flow).
  'promotion_offered',
  'disputed',
] as const;
export type SoState = (typeof SO_STATES)[number];

const soSchema = new Schema(
  {
    soNo: { type: String, required: true, unique: true },
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    // New — M6, WF-11's "restored to standing demand" path. Set only when
    // this SO was created from an accepted ask/quote (demand.service.ts
    // `acceptAskFill`); null for the direct listing/pile path, which has no
    // ask to restore to. Read-only after creation.
    askId: { type: Schema.Types.ObjectId, ref: 'Ask', default: null },
    // BR-060 — the wall is enforced at the DTO layer (TD-008), not by
    // omitting this from storage: every seller-side module (chain.service.ts
    // `createPo`, dock, marg, movement) needs it to place the PO, and
    // BuyerSoDto (chain.dto.ts) simply never reads this field.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    tierAtOrder: {
      type: String,
      enum: ['Distributor', 'Dealer', 'Retailer', 'Trader'],
      required: true,
    },
    deliveryLocationId: { type: Schema.Types.ObjectId, ref: 'BuyerLocation', default: null },
    outOfScopeDelivery: { type: Boolean, required: true, default: false },
    placeOfSupply: { type: String, enum: ['intra_state', 'inter_state'], required: true },
    state: { type: String, enum: SO_STATES, required: true, default: 'awaiting_payment' },
    payDeadline: { type: Date, required: true },
    deliveryWindowEndsAt: { type: Date, default: null },
    totalPaise: { type: Number, required: true },
  },
  { timestamps: true },
);

soSchema.index({ state: 1, payDeadline: 1 });
soSchema.index({ buyerId: 1 });
soSchema.index({ chainId: 1 });

export type SoDocument = InferSchemaType<typeof soSchema>;
export const So = model<SoDocument>('So', soSchema, 'so');
