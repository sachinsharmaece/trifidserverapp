import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Ask, type AskState } from '../../models/Ask.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Pile, type PileDecision } from '../../models/Pile.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { So } from '../../models/So.js';
import { createTradeEnquiryInSession } from './enquiry.sync.js';
import { deriveAskStatus, derivePileRequestStatus } from './enquiry.status.js';

/**
 * DEC-051 — one-off, idempotent: gives every ask and pile request raised
 * before the enquiry record existed its enquiry, numbered in the financial
 * year it was raised, and links the orders it already became. Safe to run
 * again: it only touches asks/requests whose `enquiryId` is still null, each
 * in its own transaction. `npm run backfill:enquiries`.
 */
export async function backfillEnquiries(): Promise<{ asks: number; pileRequests: number }> {
  let asks = 0;
  for (const ask of await Ask.find({ enquiryId: null }).sort({ createdAt: 1 })) {
    const staffRaise = (ask.proxyLog ?? []).find((entry) => entry.action === 'raise_ask');
    await withTransaction(async (session) => {
      const enquiryId = await createTradeEnquiryInSession(
        {
          kind: 'ask',
          channel: staffRaise ? 'sales_call' : 'self',
          raisedAt: ask.createdAt,
          raisedBy: (staffRaise?.actingStaffId as Types.ObjectId | undefined) ?? null,
          buyerId: ask.buyerId as Types.ObjectId,
          skuId: (ask.skuId as Types.ObjectId | null) ?? null,
          productId: (ask.productId as Types.ObjectId | null) ?? null,
          qty: ask.qty,
          requirement: {
            expiryBand: ask.conditionRequirement?.expiryBand ?? null,
            deliveryBand: ask.conditionRequirement?.deliveryBand ?? null,
          },
          askId: ask._id as Types.ObjectId,
        },
        deriveAskStatus({ state: ask.state as AskState, visibleToAllAt: ask.visibleToAllAt }),
        session,
      );
      await Ask.updateOne({ _id: ask._id }, { $set: { enquiryId } }, { session });
      await So.updateMany(
        { askId: ask._id, enquiryId: null },
        { $set: { enquiryId } },
        { session },
      );
    });
    asks += 1;
  }

  let pileRequests = 0;
  for (const request of await PileRequest.find({ enquiryId: null }).sort({ requestedAt: 1 })) {
    const pile = await Pile.findById(request.pileId);
    const line = pile ? await ListingLine.findById(pile.listingLineId) : null;
    const listing = line ? await Listing.findById(line.listingId) : null;
    if (!pile || !line) continue; // Orphaned request — nothing to describe.
    await withTransaction(async (session) => {
      const enquiryId = await createTradeEnquiryInSession(
        {
          kind: 'pile_request',
          channel: 'self', // No staff proxy exists for taking a listed rate.
          raisedAt: request.requestedAt,
          buyerId: request.buyerId as Types.ObjectId,
          skuId: line.skuId as Types.ObjectId,
          productId: (listing?.productId as Types.ObjectId | undefined) ?? null,
          qty: request.qty,
          pileRequestId: request._id as Types.ObjectId,
        },
        derivePileRequestStatus({
          decision: (pile.decision ?? null) as PileDecision | null,
          executedAt: pile.executedAt ?? null,
          shortfall: pile.shortfall,
        }),
        session,
      );
      await PileRequest.updateOne({ _id: request._id }, { $set: { enquiryId } }, { session });
      await So.updateMany(
        { pileRequestId: request._id, enquiryId: null },
        { $set: { enquiryId } },
        { session },
      );
    });
    pileRequests += 1;
  }

  return { asks, pileRequests };
}
