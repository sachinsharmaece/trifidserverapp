import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { ListingModel, SellerModel } from '../../models/index.js';
import { MANUAL_AUTO_OFF_REASONS } from '../../shared/enums.js';
import { conflict, invalidField, notFound } from '../../shared/errors.js';
import { logEvent } from './eventLog.js';

/**
 * Auto-confirm on a listing (reference lib/listing/autoConfirm.ts, FAST-ORDER LOCK-42 Part A). The only writer of a
 * listing's auto-confirm fields. Purchase turns it on for a number of boxes; an order up to the boxes left is then
 * confirmed by the system at "Send to seller" (trades/commands.ts), and the boxes left go down. At 0 it turns
 * itself off. TriFid Stock's listings are always on and cannot be switched.
 */

const ALLOWED_TIERS = new Set(['VERIFIED', 'TRUSTED']);

export const autoConfirmBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('on'),
    boxes: z
      .number()
      .int('Enter whole boxes')
      .min(1, 'Enter boxes to accept automatically (at least 1).'),
  }),
  z.object({
    action: z.literal('off'),
    reason: z.enum(MANUAL_AUTO_OFF_REASONS, {
      message: 'Select a reason: Sold elsewhere, Stock short, Rate changing or Other',
    }),
    note: z.string().trim().max(300).optional(),
  }),
]);

async function listingWithSeller(listingId: string, session?: ClientSession | null) {
  const listing = await ListingModel.findById(listingId).session(session ?? null);
  if (!listing) throw notFound('Listing not found.');
  const seller = await SellerModel.findById(listing.sellerId)
    .session(session ?? null)
    .orFail();
  return { listing, seller };
}

/** Turn auto-confirm ON for `boxes` (1 to the listing's stock). Verified or Trusted sellers only. */
export async function turnOn(listingId: string, boxes: number, userId: string) {
  const { listing, seller } = await listingWithSeller(listingId);
  if (seller.isHouse) {
    throw conflict(
      "TriFid Stock's auto-confirm is always on — it cannot be toggled",
      'HOUSE_LISTING',
    );
  }
  if (!ALLOWED_TIERS.has(seller.tier)) {
    throw invalidField('tier', 'New sellers cannot use auto-confirm — Verified or Trusted only');
  }
  if (listing.status !== 'ACTIVE') {
    throw conflict('Only a live listing can use auto-confirm.', 'LISTING_NOT_LIVE');
  }
  if (boxes > listing.quantityBoxes) {
    throw invalidField(
      'boxes',
      `Boxes cannot exceed the listing's stock (${listing.quantityBoxes})`,
    );
  }
  listing.set({
    autoConfirm: true,
    autoBoxesSet: boxes,
    autoBoxesLeft: boxes,
    autoOnBy: userId,
    autoOnAt: new Date(),
    autoOffReason: undefined,
    autoOffNote: undefined,
    autoOffBy: undefined,
    autoOffAt: undefined,
  });
  await listing.save();
  await logEvent({
    category: 'LISTING',
    entityType: 'Listing',
    entityId: listing._id,
    partyId: listing.sellerId,
    action: 'AUTO_ON',
    userId,
    newValue: { boxes },
  });
  return listing;
}

/** Turn auto-confirm OFF with a reason (OTHER needs a note). */
export async function turnOff(
  listingId: string,
  reason: string,
  note: string | undefined,
  userId: string,
) {
  const { listing, seller } = await listingWithSeller(listingId);
  if (seller.isHouse) {
    throw conflict(
      "TriFid Stock's auto-confirm is always on — it cannot be toggled",
      'HOUSE_LISTING',
    );
  }
  if (reason === 'OTHER' && !note) {
    throw invalidField('note', 'A note is required when the reason is Other');
  }
  listing.set({
    autoConfirm: false,
    autoBoxesLeft: 0,
    autoOffReason: reason,
    autoOffNote: note || undefined,
    autoOffBy: userId,
    autoOffAt: new Date(),
  });
  await listing.save();
  await logEvent({
    category: 'LISTING',
    entityType: 'Listing',
    entityId: listing._id,
    partyId: listing.sellerId,
    action: 'AUTO_OFF',
    userId,
    newValue: { reason, note: note ?? null },
  });
  return listing;
}

/** Does the listing's auto-confirm cover this many boxes right now? */
export function autoCovers(
  listing: { autoConfirm?: boolean | null; autoBoxesLeft?: number | null },
  boxes: number,
): boolean {
  return Boolean(listing.autoConfirm) && (listing.autoBoxesLeft ?? 0) >= boxes && boxes > 0;
}

/**
 * An order was auto-confirmed: the boxes left go down by its boxes. At 0 it turns itself off (the system), except
 * for TriFid Stock, which only refills from Stock POs.
 */
export async function consume(listingId: Types.ObjectId, boxes: number, session: ClientSession) {
  const { listing, seller } = await listingWithSeller(String(listingId), session);
  const left = Math.max(0, (listing.autoBoxesLeft ?? 0) - boxes);
  const off = left === 0 && !seller.isHouse;
  await ListingModel.updateOne(
    { _id: listing._id },
    {
      $set: {
        autoBoxesLeft: left,
        ...(off ? { autoConfirm: false, autoOffReason: 'AUTO_EMPTY', autoOffAt: new Date() } : {}),
      },
    },
    { session },
  );
  await logEvent(
    {
      category: 'LISTING',
      entityType: 'Listing',
      entityId: listing._id,
      partyId: listing.sellerId,
      action: 'AUTO_CONSUMED',
      newValue: { boxes, left },
    },
    session,
  );
  if (off) {
    await logEvent(
      {
        category: 'LISTING',
        entityType: 'Listing',
        entityId: listing._id,
        partyId: listing.sellerId,
        action: 'AUTO_OFF',
        newValue: { reason: 'AUTO_EMPTY' },
      },
      session,
    );
  }
}

/**
 * The buyer dropped an auto-confirmed order before paying: its boxes come back, but only while auto-confirm is
 * still on (always, for TriFid Stock). Switched off since: they do not come back.
 */
export async function restore(listingId: Types.ObjectId, boxes: number, session: ClientSession) {
  const { listing, seller } = await listingWithSeller(String(listingId), session);
  if (!listing.autoConfirm && !seller.isHouse) return;
  await ListingModel.updateOne(
    { _id: listing._id },
    { $inc: { autoBoxesLeft: boxes } },
    { session },
  );
  await logEvent(
    {
      category: 'LISTING',
      entityType: 'Listing',
      entityId: listing._id,
      partyId: listing.sellerId,
      action: 'AUTO_RESTORED',
      newValue: { boxes },
    },
    session,
  );
}
