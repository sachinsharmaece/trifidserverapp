import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-02 `buyer`. One per counterparty whose `kind` is `buyer` or `both`.
 *
 * `rateTier` is **derived** — `isTrader ? 'Trader' : tradePosition` — and is
 * never accepted from a client (`BR-043`). It is exposed as a virtual, not a
 * stored field, so there is no path that writes it directly.
 *
 * `creditTermsDays` / `creditLimitPaise` are **built, feature off** (`BR-054`)
 * — present on the schema, not read or enforced by anything yet.
 */
const buyerSchema = new Schema(
  {
    counterpartyId: {
      type: Schema.Types.ObjectId,
      ref: 'Counterparty',
      required: true,
      unique: true,
    },
    tehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', default: null },
    gstPpobAddress: { type: String },
    tradePosition: { type: String, enum: ['distributor', 'dealer', 'retailer'], default: null },
    isTrader: { type: Boolean, required: true, default: false },
    // BR-044 — false until a desk classifies him; until then he sees the
    // Retailer rate marked indicative.
    classified: { type: Boolean, required: true, default: false },
    creditTermsDays: { type: Number, default: null },
    creditLimitPaise: { type: Number, default: null },
    openingBalancePaise: { type: Number, required: true, default: 0 },
    // BR-130 — desk call at 25 rate views or asks.
    rateViews: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

buyerSchema.virtual('rateTier').get(function getRateTier(this: {
  isTrader: boolean;
  tradePosition: string | null;
}) {
  // B-52 — `tradePosition` is stored lowercase (the enum); this virtual's
  // own doc comment above promises `isTrader ? 'Trader' : tradePosition`,
  // which read as `retailer` next to `Trader` for anyone actually using it.
  if (this.isTrader) return 'Trader';
  if (!this.tradePosition) return null;
  return this.tradePosition.charAt(0).toUpperCase() + this.tradePosition.slice(1);
});
buyerSchema.set('toJSON', { virtuals: true });
buyerSchema.set('toObject', { virtuals: true });

export type BuyerDocument = InferSchemaType<typeof buyerSchema>;
export const Buyer = model<BuyerDocument>('Buyer', buyerSchema, 'buyer');
