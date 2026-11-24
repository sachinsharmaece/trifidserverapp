import { Schema, model } from 'mongoose';
import { ASK_REASONS, BUYER_STAGES, REASON_CODE_CONTEXTS, BUYER_TIERS, SELLER_ANSWER_KINDS, SELLER_STAGES, TRADE_SOURCES, } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
const MAX_RATE_PAISE = 100_000_000; // ₹10,00,000 per unit: far above any real rate, only stops typing mistakes
/**
 * One trade = one buyer wanting one pack, followed from the rate board to the end (ARCH B3.4, simplified).
 * Q-WF-01 (decided): **only the trade engine (`modules/trades/engine.ts`) changes a trade.** Every screen shows it
 * and presses the engine's actions.
 *
 * The record holds both sides of the visibility wall (buyer and seller), so it is NEVER sent as it is: the API
 * builds a view for each side (`modules/trades/view.ts`).
 *
 * Simplified from ARCH: the buyer's ask and the seller's answer live inside the trade instead of in separate
 * `asks` and `confirmations` collections.
 */
const tradeSchema = new Schema({
    /** TRADE-26-0001, from `nextDocumentNumber('TRADE')`. */
    number: { type: String, required: true, match: /^TRADE-\d{2}-\d{4,}$/ },
    source: { type: String, enum: TRADE_SOURCES, required: true },
    buyerId: { ...refField('Buyer'), required: true },
    productId: { ...refField('Product'), required: true },
    /** The pack. A not-listed ask may name only the product; Purchase picks the pack when quoting. */
    skuId: refField('Sku'),
    /** The listing the buyer picked (LISTED). Cleared when the seller declines, so Purchase finds another seller. */
    listingId: refField('Listing'),
    /** Set when the trade goes to a seller (LISTED) or when Purchase records a quote (NOT_LISTED). */
    sellerId: refField('Seller'),
    buyerStage: { type: String, enum: BUYER_STAGES, required: true },
    /** Empty until the trade is sent to the seller side. */
    sellerStage: { type: String, enum: SELLER_STAGES },
    /** Boxes the buyer wants (set at "He wants it", or with the ask). */
    boxesWanted: intField(1, 1_000_000),
    /** Only for NOT_LISTED trades: why the buyer asked and any conditions. Purchase reads the note. */
    ask: {
        type: new Schema({
            reason: { type: String, enum: ASK_REASONS, required: true },
            note: textField(500),
        }, { _id: false }),
        default: undefined,
    },
    /** The seller's answer (seller side of the wall): what he confirmed or quoted. */
    sellerAnswer: {
        type: new Schema({
            kind: { type: String, enum: SELLER_ANSWER_KINDS, required: true },
            boxes: { ...intField(1, 1_000_000), required: true },
            /** The seller's rate delivered to Indore, per unit (never shown to Sales). */
            landedPaisePerUnit: { ...intField(1, MAX_RATE_PAISE), required: true },
            unitsPerBox: { ...intField(1, 10_000), required: true },
            /** Exact expiry month, YYYY-MM. */
            expiryMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
            batchNumber: textField(60),
            /** Quotes only: the smallest order and how many boxes the seller has. */
            moqBoxes: intField(1, 1_000_000),
            boxesAvailable: intField(1, 1_000_000),
            byUserId: { ...refField('User'), required: true },
            at: { type: Date, required: true },
        }, { _id: false }),
        default: undefined,
    },
    /**
     * What Sales offers the buyer (buyer side of the wall), fixed when the seller answers so the rate does not
     * move while the buyer decides. `buyerRatePaisePerUnit` is null when the margin matrix had no cell.
     */
    offer: {
        type: new Schema({
            buyerRatePaisePerUnit: {
                type: Number,
                default: null,
                validate: {
                    // Empty (no margin cell) or a whole number of paise.
                    validator: (value) => value === null ||
                        (Number.isSafeInteger(value) && value >= 1 && value <= MAX_RATE_PAISE * 2),
                    message: 'buyerRatePaisePerUnit must be empty or a whole number of paise',
                },
            },
            tier: { type: String, enum: BUYER_TIERS, required: true },
            /** True when the buyer was not classified yet (priced as Retailer). */
            indicative: { type: Boolean, required: true },
        }, { _id: false }),
        default: undefined,
    },
    /** The sales order raised when the buyer said yes (b6). Cleared when a lost trade is reopened. */
    salesOrderId: refField('SalesOrder'),
    /** Why the trade was lost (X_LEAKAGE): the buyer said no (BUYER_NO) or dropped the order (B6_LEAK). */
    leakage: {
        type: new Schema({
            context: { type: String, enum: REASON_CODE_CONTEXTS, required: true },
            reasonCodeId: { ...refField('ReasonCode'), required: true },
            /** The reason's words when it was picked, so the history reads the same if the code is renamed. */
            reasonLabel: { ...textField(120), required: true },
            note: textField(300),
            byUserId: { ...refField('User'), required: true },
            at: { type: Date, required: true },
        }, { _id: false }),
        default: undefined,
    },
    /** The clock for whoever acts next, from Settings (SRS-TRD-04). Empty = no clock at this stage. */
    dueAt: Date,
    /** The Sales person who opened it (the owner, for later team scope). */
    ownerUserId: { ...refField('User'), required: true },
    lastActionAt: { type: Date, required: true },
    /** Goes up by 1 on every action, so two people pressing at once cannot both win (409 STALE_TRADE). */
    version: { ...intField(0), required: true, default: 0 },
}, { collection: 'trades', timestamps: true, versionKey: false });
tradeSchema.index({ number: 1 }, { unique: true });
tradeSchema.index({ buyerStage: 1, lastActionAt: -1 });
tradeSchema.index({ sellerStage: 1, lastActionAt: -1 });
tradeSchema.index({ buyerId: 1, createdAt: -1 });
// A buyer has at most one open "viewing" (b1) per listing: opening the same row again returns it (BR-23).
tradeSchema.index({ buyerId: 1, listingId: 1 }, { unique: true, partialFilterExpression: { buyerStage: 'B1_VIEWING' } });
export const TradeModel = model('Trade', tradeSchema);
//# sourceMappingURL=trade.model.js.map