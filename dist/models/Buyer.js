import { Schema, model } from 'mongoose';
/**
 * ENT-02 `buyer`. One per counterparty whose `kind` is `buyer` or `both`.
 *
 * `rateTier` is **derived** — `category`, or for a buyer not yet migrated
 * `isTrader ? 'Trader' : tradePosition` — and is
 * never accepted from a client (`BR-043`). It is exposed as a virtual, not a
 * stored field, so there is no path that writes it directly.
 *
 * `creditTermsDays` / `creditLimitPaise` are **built, feature off** (`BR-054`)
 * — present on the schema, not read or enforced by anything yet.
 */
const buyerSchema = new Schema({
    counterpartyId: {
        type: Schema.Types.ObjectId,
        ref: 'Counterparty',
        required: true,
        unique: true,
    },
    tehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', default: null },
    gstPpobAddress: { type: String },
    // Phase 3 (DEC-058) — the one category, which is the margin-matrix
    // column. Replaces tradePosition + isTrader, which stay (deprecated,
    // read only as a fallback) until a later clean-up.
    category: {
        type: String,
        enum: ['Retailer', 'Dealer', 'Distributor', 'Trader'],
        default: null,
    },
    tradePosition: { type: String, enum: ['distributor', 'dealer', 'retailer'], default: null },
    isTrader: { type: Boolean, required: true, default: false },
    // Phase 3 — the LocationBlock's address and pincode (BR-349: pincode is
    // stored only). Tehsil stays the resolver's unit (BR-081).
    address: { type: String, default: null },
    pincode: { type: String, default: null },
    // Phase 3 — the buyer's party code in Marg, for automated billing later.
    // Unique among buyers; the seller ledger is a separate Marg ledger.
    margPartyCode: { type: String, default: null },
    // BR-044 — false until a desk classifies him; until then he sees the
    // Retailer rate marked indicative.
    classified: { type: Boolean, required: true, default: false },
    creditTermsDays: { type: Number, default: null },
    creditLimitPaise: { type: Number, default: null },
    openingBalancePaise: { type: Number, required: true, default: 0 },
    // BR-130 — desk call at 25 rate views or asks.
    rateViews: { type: Number, required: true, default: 0 },
}, { timestamps: true });
buyerSchema.index({ margPartyCode: 1 }, { unique: true, partialFilterExpression: { margPartyCode: { $type: 'string' } } });
buyerSchema.virtual('rateTier').get(function getRateTier() {
    if (this.category)
        return this.category;
    // B-52 — `tradePosition` is stored lowercase (the enum); this virtual's
    // own doc comment above promises `isTrader ? 'Trader' : tradePosition`,
    // which read as `retailer` next to `Trader` for anyone actually using it.
    if (this.isTrader)
        return 'Trader';
    if (!this.tradePosition)
        return null;
    return this.tradePosition.charAt(0).toUpperCase() + this.tradePosition.slice(1);
});
buyerSchema.set('toJSON', { virtuals: true });
buyerSchema.set('toObject', { virtuals: true });
export const Buyer = model('Buyer', buyerSchema, 'buyer');
