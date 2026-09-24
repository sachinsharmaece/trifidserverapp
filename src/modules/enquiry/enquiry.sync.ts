import type { ClientSession, Types } from 'mongoose';
import { Enquiry, type EnquiryChannel } from '../../models/Enquiry.js';
import { Ask, type AskState } from '../../models/Ask.js';
import { Pile, type PileDecision } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { nextEnquiryNo } from '../chain/chain.numbering.js';
import { AppError } from '../../shared/errors.js';
import {
  deriveAskStatus,
  derivePileRequestStatus,
  type EnquiryStatusFields,
} from './enquiry.status.js';

/**
 * DEC-051 — the ONLY writer of an enquiry's stored status. Every service that
 * changes `ask.state` or `pile.decision` calls one of the `sync*` functions
 * below with its own transaction's session, so the enquiry and the trade
 * commit together or not at all. The status is re-derived from the source
 * document every time (never passed in), so a sync is idempotent and a late
 * or repeated call can only ever make the enquiry more correct.
 *
 * A pre-trade enquiry has no trade document to read; its two statuses
 * (`pre_trade`, `dropped`) are written by the create/drop that set them.
 */

type Id = Types.ObjectId | string;

interface NewTradeEnquiry {
  kind: 'ask' | 'pile_request';
  channel: EnquiryChannel;
  raisedAt: Date;
  raisedBy?: Id | null;
  buyerId: Id;
  skuId?: Id | null;
  productId?: Id | null;
  qty: number;
  requirement?: { expiryBand?: string | null; deliveryBand?: string | null } | null;
  askId?: Id;
  pileRequestId?: Id;
}

/** Creates the enquiry for a just-created ask or pile request, with its first status. */
export async function createTradeEnquiryInSession(
  input: NewTradeEnquiry,
  status: EnquiryStatusFields,
  session: ClientSession,
): Promise<Types.ObjectId> {
  const [enquiry] = await Enquiry.create(
    [
      {
        enquiryNo: await nextEnquiryNo(input.raisedAt, session),
        kind: input.kind,
        channel: input.channel,
        raisedAt: input.raisedAt,
        raisedBy: input.raisedBy ?? null,
        buyerId: input.buyerId,
        skuId: input.skuId ?? null,
        productId: input.productId ?? null,
        qty: input.qty,
        requirement: input.requirement ?? null,
        askId: input.askId ?? null,
        pileRequestId: input.pileRequestId ?? null,
        ...status,
        statusChangedAt: input.raisedAt,
      },
    ],
    { session, ordered: true },
  );
  if (!enquiry) throw new Error('Enquiry.create returned no document.');
  return enquiry._id as Types.ObjectId;
}

/**
 * DEC-052 — a pre-trade enquiry becomes the ask just raised for it: same
 * enquiry, same number, same owners, follow-ups and notes. What it was asked
 * as (prospect, free-text product) stays on the record as history.
 */
export async function convertPreTradeEnquiryInSession(
  enquiryId: Id,
  input: Omit<NewTradeEnquiry, 'kind' | 'channel' | 'raisedAt' | 'raisedBy' | 'pileRequestId'> & {
    askId: Id;
  },
  status: EnquiryStatusFields,
  now: Date,
  session: ClientSession,
): Promise<Types.ObjectId> {
  const enquiry = await Enquiry.findById(enquiryId).session(session);
  if (!enquiry) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Enquiry not found.' });
  if (enquiry.kind !== 'pre_trade' || enquiry.status !== 'pre_trade') {
    throw new AppError({
      code: 'ENQUIRY_NOT_OPEN',
      messageEn: 'Only an open pre-trade enquiry can be converted to an ask.',
    });
  }
  if (enquiry.buyerId && String(enquiry.buyerId) !== String(input.buyerId)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This enquiry belongs to a different buyer.',
      field: 'buyerCounterpartyId',
    });
  }
  await Enquiry.updateOne(
    { _id: enquiry._id },
    {
      $set: {
        kind: 'ask',
        askId: input.askId,
        buyerId: input.buyerId,
        skuId: input.skuId ?? null,
        productId: input.productId ?? null,
        qty: input.qty,
        requirement: input.requirement ?? null,
        ...status,
        statusChangedAt: now,
      },
    },
    { session },
  );
  return enquiry._id as Types.ObjectId;
}

async function writeStatus(
  enquiry: InstanceType<typeof Enquiry>,
  next: EnquiryStatusFields,
  now: Date,
  session: ClientSession,
): Promise<void> {
  if (
    enquiry.status === next.status &&
    enquiry.phase === next.phase &&
    enquiry.outcome === next.outcome &&
    (enquiry.waitingOn ?? null) === next.waitingOn
  ) {
    return;
  }
  await Enquiry.updateOne(
    { _id: enquiry._id },
    {
      $set: {
        ...next,
        statusChangedAt: now,
        closedAt: next.phase === 'closed' ? now : null,
      },
    },
    { session },
  );
}

/** Re-derives and stores the status of the enquiry that IS this ask. No-op for a pre-enquiry ask. */
export async function syncEnquiryForAsk(
  askId: Id,
  session: ClientSession,
  now: Date = new Date(),
): Promise<void> {
  const enquiry = await Enquiry.findOne({ askId }).session(session);
  if (!enquiry) return;
  const ask = await Ask.findById(askId).session(session);
  if (!ask) return;
  await writeStatus(
    enquiry,
    deriveAskStatus({ state: ask.state as AskState, visibleToAllAt: ask.visibleToAllAt }, now),
    now,
    session,
  );
}

/** One pile decision moves every buyer's enquiry on that pile — re-derive them all. */
export async function syncEnquiriesForPile(
  pileId: Id,
  session: ClientSession,
  now: Date = new Date(),
): Promise<void> {
  const pile = await Pile.findById(pileId).session(session);
  if (!pile) return;
  const requestIds = (await PileRequest.find({ pileId }, { _id: 1 }).session(session)).map(
    (r) => r._id,
  );
  const enquiries = await Enquiry.find({ pileRequestId: { $in: requestIds } }).session(session);
  const next = derivePileRequestStatus({
    decision: (pile.decision ?? null) as PileDecision | null,
    executedAt: pile.executedAt ?? null,
    shortfall: pile.shortfall,
  });
  for (const enquiry of enquiries) await writeStatus(enquiry, next, now, session);
}
