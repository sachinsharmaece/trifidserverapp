import { Schema, model } from 'mongoose';
/**
 * ENT-17 `listing`. BR-085 — `frozenTehsilIds` is the whole territory
 * design: frozen at listing time, never a live reference to the seller's
 * current area. Widening reach is a new listing, never an edit.
 */
export const LISTING_SCOPE_TYPES = ['my_area', 'all_india', 'all_except_mine', 'custom'];
/**
 * RECTIFY-01 — why staff stopped a listing or withdrew a quote. A fixed dropdown, as BR-048's reason
 * codes are: free text destroys every report built on top of it (CH §27.2); the note carries the detail.
 */
export const STOP_REASON_CODES = [
    'maintenance',
    'stock_gone',
    'rate_wrong',
    'seller_request',
    'compliance',
    'other',
];
const listingSchema = new Schema({
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    origin: { type: String, enum: ['seller_initiated', 'quote_born'], required: true },
    scopeType: { type: String, enum: LISTING_SCOPE_TYPES, required: true },
    frozenTehsilIds: [{ type: Schema.Types.ObjectId, ref: 'Tehsil' }],
    state: { type: String, enum: ['live', 'paused', 'withdrawn'], required: true, default: 'live' },
    expiresAt: { type: Date, required: true },
    pausedAt: { type: Date, default: null },
    lastConfirmedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    // M8, BR-108 — "one reminder fires shortly before it drops". Set by the daily
    // listing-dropping job the first time it fires, and never cleared, so the
    // reminder goes once per listing rather than once per day.
    // (A relist starts a fresh window, so `relistListing` clears it.)
    dropReminderSentAt: { type: Date, default: null },
    // RECTIFY-01 Phase 0 — a listing TriFid staff stopped. The state is the existing `paused`; these
    // say who paused it. While `stoppedBy` is `staff` the seller cannot relist it (only the staff
    // restart lifts it). All default to null, so a reader that does not know them sees nothing new.
    stoppedBy: { type: String, enum: ['staff'], default: null },
    stoppedByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    stopReasonCode: { type: String, enum: STOP_REASON_CODES, default: null },
    stopNote: { type: String, default: null },
    // Set by the emergency script so one run can be undone as one batch (restartStopped.ts).
    stopBatchId: { type: String, default: null },
}, { timestamps: true });
listingSchema.index({ sellerId: 1, state: 1 });
listingSchema.index({ productId: 1, state: 1 });
listingSchema.index({ state: 1, expiresAt: 1 });
export const Listing = model('Listing', listingSchema, 'listing');
