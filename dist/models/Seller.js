import { Schema, model } from 'mongoose';
/**
 * ENT-05 `seller`. One per counterparty whose `kind` is `seller` or `both`.
 * BR-246 — four tiers, lifetime cumulative, **monotonic**: enforced in the
 * service layer (a tier assignment never moves the value backward), not
 * here — a schema enum has no notion of ordering to enforce.
 *
 * **A seller has no rate tier** — TriFid never quotes him a price (`BR-251`).
 */
const sellerSchema = new Schema({
    counterpartyId: {
        type: Schema.Types.ObjectId,
        ref: 'Counterparty',
        required: true,
        unique: true,
    },
    trustTier: {
        type: String,
        enum: ['New', 'Verified', 'Trusted', 'Committed'],
        required: true,
        default: 'New',
    },
    tierSeededBy: { type: Schema.Types.ObjectId, default: null },
    tierSeededReason: { type: String, default: null },
    dispatchCutoffTime: { type: String, required: true, default: '16:00' },
    suppliesCompleted: { type: Number, required: true, default: 0 },
    openingBalancePaise: { type: Number, required: true, default: 0 },
    // Phase 4 — the seller's own place (LocationBlock): address, pincode
    // (stored only, BR-349) and the tehsil it is in. Not his area — the
    // tehsils he supplies stay on seller_area (BR-082/BR-083).
    tehsilId: { type: Schema.Types.ObjectId, ref: 'Tehsil', default: null },
    address: { type: String, default: null },
    pincode: { type: String, default: null },
    // Phase 4 — his party code in Marg, a separate Marg ledger from any buyer
    // ledger of the same firm. Unique among sellers.
    margPartyCode: { type: String, default: null },
    // Phase 6 (DEC-064) — set when he came from Push to Purchase: the buyer
    // profile he was pushed from (same counterparty) and the Sales executive
    // who pushed him. Never change.
    pushedFromBuyerId: {
        type: Schema.Types.ObjectId,
        ref: 'Buyer',
        default: null,
        immutable: true,
    },
    sourcedByEmployeeId: {
        type: Schema.Types.ObjectId,
        ref: 'Employee',
        default: null,
        immutable: true,
    },
}, { timestamps: true });
sellerSchema.index({ margPartyCode: 1 }, { unique: true, partialFilterExpression: { margPartyCode: { $type: 'string' } } });
export const Seller = model('Seller', sellerSchema, 'seller');
