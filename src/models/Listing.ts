import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-17 `listing`. BR-085 — `frozenTehsilIds` is the whole territory
 * design: frozen at listing time, never a live reference to the seller's
 * current area. Widening reach is a new listing, never an edit.
 */
export const LISTING_SCOPE_TYPES = ['my_area', 'all_india', 'all_except_mine', 'custom'] as const;
export type ListingScopeType = (typeof LISTING_SCOPE_TYPES)[number];

const listingSchema = new Schema(
  {
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
  },
  { timestamps: true },
);

listingSchema.index({ sellerId: 1, state: 1 });
listingSchema.index({ productId: 1, state: 1 });
listingSchema.index({ state: 1, expiresAt: 1 });

export type ListingDocument = InferSchemaType<typeof listingSchema>;
export const Listing = model<ListingDocument>('Listing', listingSchema, 'listing');
