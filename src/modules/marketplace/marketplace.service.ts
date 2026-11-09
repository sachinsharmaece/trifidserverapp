import type { ClientSession, Types } from 'mongoose';
import { PERMISSIONS } from '../../config/permissions.js';
import { withTransaction } from '../../db/transaction.js';
import { Ask } from '../../models/Ask.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Listing, type StopReasonCode } from '../../models/Listing.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Pool, buildConditionSetKey } from '../../models/Pool.js';
import { PoolCommitment } from '../../models/PoolCommitment.js';
import { Product } from '../../models/Product.js';
import { OPEN_QUOTE_STATUSES, Quote } from '../../models/Quote.js';
import { OPEN_RATE_CHANGE_STATUSES, RateChangeRequest } from '../../models/RateChangeRequest.js';
import { Seller } from '../../models/Seller.js';
import { Sku } from '../../models/Sku.js';
import { So } from '../../models/So.js';
import { writeAuditLog } from '../../shared/audit.js';
import { addDays } from '../../shared/clock.js';
import { AppError } from '../../shared/errors.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { settleAskAfterQuoteLeaves } from '../demand/demand.service.js';
import { syncEnquiryForAsk } from '../enquiry/enquiry.sync.js';
import { LISTING_LIFE_DAYS } from '../listing/listing.service.js';
import { isProductSellable } from '../listing/listing.sellable.js';
import { notifyStaff } from '../notice/notice.service.js';
import { findCurrentSupplier } from '../pool/pool.service.js';
import {
  activeAdminIds,
  declineOpenPiles,
  firmOfBuyer,
  id,
  productNameOf,
  reasonText,
  salesDeskFor,
  tellSalesToCall,
  type StopContext,
} from './marketplace.closure.js';

export type { StopContext } from './marketplace.closure.js';

/**
 * RECTIFY-01 Phase 0 — staff stop trading at once.
 *
 * A listing TriFid stops is the existing `paused` state, tagged `stoppedBy: 'staff'`: the buyer feed
 * and offers already read `state: 'live'` only, so it leaves them with no app change, and the
 * seller's own relist is refused until staff restart it. A quote TriFid withdraws is the existing
 * `withdrawn` status, which nothing wrote before. Neither carries a strike or a rank, and the
 * buyer is never messaged — the founder wants a call, not a WhatsApp.
 *
 * The wall (BR-060/BR-069): a Sales notice names buyers and never the seller; nothing here that
 * Purchase can read names a buyer.
 */

export interface StopCaller {
  employeeId: string;
  permissions: string[];
  correlationId: string;
}

export interface StopInput {
  reasonCode: StopReasonCode;
  note: string;
  /** With this false or absent nothing is written: the call answers with the impact preview. */
  confirm?: boolean;
  /** Admin only: stop a listing whose supplied pool has commitments. The pool itself is not changed. */
  confirmPools?: boolean;
  /** Admin only, on top of `confirmPools`: a commitment in that pool is already paid. */
  confirmPaidPools?: boolean;
}

// Orders that are finished one way or the other; everything else is "open" for the preview.
const FINISHED_ORDER_STATES = ['closed', 'cancelled', 'supply_failed'];

// ---------------------------------------------------------------------------
// Stopping a listing
// ---------------------------------------------------------------------------

/**
 * One open pool on the packs and conditions of a listing. Counts and boxes only: Purchase never
 * sees which buyer committed.
 */
export interface PoolRow {
  poolId: string;
  packLabel: string;
  status: string;
  moq: number;
  commitments: number;
  paidCommitments: number;
  boxesCommitted: number;
  /** This listing's seller is who supplies the pool right now (BR-152). Only such a pool can block a stop. */
  suppliedByThisSeller: boolean;
}

/** Who supplies a pool, found once per pool for a whole bulk plan. */
export type SupplierCache = Map<string, Promise<{ sellerId: Types.ObjectId } | null>>;

export interface ListingImpact {
  /** Already stopped by staff: a second stop changes nothing. */
  alreadyStopped: boolean;
  listing: {
    listingId: string;
    product: string;
    /** Purchase's own side of the wall — the seller. Never a buyer. */
    sellerFirm: string;
    origin: string;
    state: string;
    expiresAt: string;
    stoppedByTriFid: boolean;
  };
  lines: Array<{ listingLineId: string; packLabel: string; qty: number; ratePaise: number }>;
  boxesInStock: number;
  piles: { open: number; boxesPiled: number; buyers: number };
  /** Piles the seller confirmed that have not yet given the buyers their deal (the 5-second undo, or stuck). */
  pilesConfirmingNotOffered: number;
  /** Deals already offered to buyers (BR-378): left alone, they run to the end of their 24 hours. */
  offeredDealsRunning: { count: number; boxes: number };
  quotes: { parked: number; live: number };
  pools: {
    /** Every open pool on these packs and conditions, whoever supplies it. */
    open: number;
    /** Of those, the ones this listing's seller supplies. The rest depend on somebody else. */
    suppliedByThisSeller: number;
    /** Of the ones he supplies: those somebody has committed to. */
    withCommitments: number;
    /** Of the ones he supplies: those with a commitment already paid. */
    withPaidCommitments: number;
    list: PoolRow[];
  };
  /** Orders already raised from this listing's lines or quotes. They are not touched. */
  openOrdersUntouched: number;
}

export async function getListingImpact(
  listing: InstanceType<typeof Listing>,
  now: Date = new Date(),
  supplierCache: SupplierCache = new Map(),
): Promise<ListingImpact> {
  const lines = await ListingLine.find({ listingId: listing._id });
  const lineIds = lines.map((line) => line._id);
  const [skus, seller, product] = await Promise.all([
    Sku.find({ _id: { $in: lines.map((line) => line.skuId) } }, { packLabel: 1 }),
    Seller.findById(listing.sellerId, { counterpartyId: 1 }),
    Product.findById(listing.productId, { brand: 1 }),
  ]);
  const counterparty = seller
    ? await Counterparty.findById(seller.counterpartyId, { firm: 1 })
    : null;
  const packById = new Map(skus.map((sku) => [id(sku._id), sku.packLabel]));

  const piles = await Pile.find({ listingLineId: { $in: lineIds } });
  const openPiles = piles.filter((pile) => !pile.decision);
  const openRequests =
    openPiles.length > 0
      ? await PileRequest.find({ pileId: { $in: openPiles.map((pile) => pile._id) } })
      : [];
  const decidedPileIds = piles.filter((pile) => pile.decision).map((pile) => pile._id);
  const offered =
    decidedPileIds.length > 0
      ? await PileRequest.find({
          pileId: { $in: decidedPileIds },
          offerState: 'offered',
          holdUntil: { $gt: now },
        })
      : [];
  const allRequestIds = (
    piles.length > 0
      ? await PileRequest.find({ pileId: { $in: piles.map((p) => p._id) } }, { _id: 1 })
      : []
  ).map((request) => request._id);

  const quotes = await Quote.find({ listingLineId: { $in: lineIds } }, { status: 1, askId: 1 });
  const openQuotes = quotes.filter((quote) =>
    (OPEN_QUOTE_STATUSES as readonly string[]).includes(quote.status),
  );

  const pools = await countPools(lines, listing.sellerId as Types.ObjectId, supplierCache);

  const openOrdersUntouched =
    allRequestIds.length === 0 && quotes.length === 0
      ? 0
      : await So.countDocuments({
          state: { $nin: FINISHED_ORDER_STATES },
          $or: [
            { pileRequestId: { $in: allRequestIds } },
            ...(quotes.length > 0
              ? [{ askId: { $in: quotes.map((quote) => quote.askId) }, sellerId: listing.sellerId }]
              : []),
          ],
        });

  const alreadyStopped = listing.state === 'paused' && listing.stoppedBy === 'staff';
  return {
    alreadyStopped,
    listing: {
      listingId: id(listing._id),
      product: product?.brand ?? '',
      sellerFirm: counterparty?.firm ?? '',
      origin: listing.origin,
      state: listing.state,
      expiresAt: listing.expiresAt.toISOString(),
      stoppedByTriFid: listing.stoppedBy === 'staff',
    },
    lines: lines.map((line) => ({
      listingLineId: id(line._id),
      packLabel: packById.get(id(line.skuId)) ?? '',
      qty: line.qty,
      ratePaise: line.ratePaise,
    })),
    boxesInStock: lines.reduce((sum, line) => sum + line.qty, 0),
    piles: {
      open: openPiles.length,
      boxesPiled: openRequests.reduce((sum, request) => sum + request.qty, 0),
      buyers: new Set(openRequests.map((request) => id(request.buyerId))).size,
    },
    pilesConfirmingNotOffered: piles.filter(
      (pile) => pile.decision === 'confirmed' && !pile.executedAt,
    ).length,
    offeredDealsRunning: {
      count: offered.length,
      boxes: offered.reduce((sum, request) => sum + (request.offerQty ?? request.qty), 0),
    },
    quotes: {
      parked: openQuotes.filter((quote) => quote.status === 'pending_sales').length,
      live: openQuotes.filter((quote) => quote.status === 'live').length,
    },
    pools,
    openOrdersUntouched,
  };
}

/**
 * Pools belong to a condition set on a pack, not to one seller's listing (BR-151), and the supplier
 * is recomputed from every live listing on that pack (BR-152). So the pools "on" a listing are the
 * open ones its lines' packs and condition sets would feed — all listed — but only the ones this
 * listing's seller supplies right now can be hurt by stopping it, and only those count towards the
 * gate (see `stopGateFor`). A pool someone else supplies is listed and never blocks.
 */
async function countPools(
  lines: Array<InstanceType<typeof ListingLine>>,
  sellerId: Types.ObjectId,
  supplierCache: SupplierCache,
): Promise<ListingImpact['pools']> {
  const none = {
    open: 0,
    suppliedByThisSeller: 0,
    withCommitments: 0,
    withPaidCommitments: 0,
    list: [],
  };
  const keys = new Set(lines.map((line) => `${id(line.skuId)}|${buildConditionSetKey(line)}`));
  if (keys.size === 0) return none;
  const candidates = await Pool.find({
    skuId: { $in: lines.map((line) => line.skuId) },
    isActive: true,
  });
  const matching = candidates.filter((pool) =>
    keys.has(`${id(pool.skuId)}|${pool.conditionSetKey}`),
  );
  if (matching.length === 0) return none;
  const skus = await Sku.find(
    { _id: { $in: matching.map((pool) => pool.skuId) } },
    { packLabel: 1 },
  );
  const packById = new Map(skus.map((sku) => [id(sku._id), sku.packLabel]));

  const list: PoolRow[] = [];
  for (const pool of matching) {
    const commitments = await PoolCommitment.find({ poolId: pool._id, withdrawnAt: null });
    const key = id(pool._id);
    if (!supplierCache.has(key)) supplierCache.set(key, findCurrentSupplier(pool));
    const supplier = await supplierCache.get(key)!;
    list.push({
      poolId: key,
      packLabel: packById.get(id(pool.skuId)) ?? '',
      status: pool.status,
      moq: pool.moq,
      commitments: commitments.length,
      paidCommitments: commitments.filter((commitment) => commitment.paidAt).length,
      boxesCommitted: commitments.reduce(
        (sum, commitment) => sum + (Number.isFinite(commitment.qty) ? commitment.qty : 0),
        0,
      ),
      suppliedByThisSeller: supplier !== null && id(supplier.sellerId) === id(sellerId),
    });
  }
  const supplied = list.filter((row) => row.suppliedByThisSeller);
  return {
    open: list.length,
    suppliedByThisSeller: supplied.length,
    withCommitments: supplied.filter((row) => row.commitments > 0).length,
    withPaidCommitments: supplied.filter((row) => row.paidCommitments > 0).length,
    list,
  };
}

/** The pools a stop leaves with a paid commitment in them: the desk has to settle these. */
export function paidSuppliedPools(impact: ListingImpact): PoolRow[] {
  return impact.pools.list.filter((row) => row.suppliedByThisSeller && row.paidCommitments > 0);
}

export type PoolConfirmation = 'confirmPools' | 'confirmPaidPools';

/** What the person at the screen must do before this stop can go through — shown in the preview. */
export interface StopGate {
  /** Set when this person cannot stop the listing at all: the dialog disables Confirm and says why. */
  blocked: { code: 'admin_only'; message: string } | null;
  /** Flags the confirming call must carry, in order. An Admin ticks each in the dialog. */
  needsConfirm: PoolConfirmation[];
}

const POOL_UNPAID_ADMIN_ONLY =
  'An open pool with commitments depends on this listing. Only Admin can stop it; ask Admin.';
const POOL_PAID_ADMIN_ONLY =
  'A pool this seller supplies has paid commitments. Only Admin can stop this listing, and the pool then has to be settled with its buyers; ask Admin.';
const POOL_CONFIRM_MESSAGE: Record<PoolConfirmation, string> = {
  confirmPools:
    'An open pool with commitments depends on this listing. Stopping the listing does not change the pool. Confirm to stop it anyway.',
  confirmPaidPools:
    'A pool this seller supplies has paid commitments. Stopping the listing does not refund or change the pool, so the desk must settle it with its buyers. Confirm to stop it anyway.',
};

/**
 * An open pool this seller supplies, with somebody committed, is not cascaded over (S3). A
 * non-Admin cannot stop such a listing. An Admin needs `confirmPools`; if a commitment is already
 * paid, also `confirmPaidPools` — a double confirm, not a wall: a stop moves no money and the
 * restart undoes it, and a brake that nobody can pull is worse than one with two ticks.
 */
export function stopGateFor(impact: ListingImpact, caller: { permissions: string[] }): StopGate {
  const { withCommitments, withPaidCommitments } = impact.pools;
  if (withCommitments === 0) return { blocked: null, needsConfirm: [] };
  const paid = withPaidCommitments > 0;
  if (!caller.permissions.includes(PERMISSIONS.SELLER_ADMIN)) {
    return {
      blocked: {
        code: 'admin_only',
        message: paid ? POOL_PAID_ADMIN_ONLY : POOL_UNPAID_ADMIN_ONLY,
      },
      needsConfirm: [],
    };
  }
  return {
    blocked: null,
    needsConfirm: paid ? ['confirmPools', 'confirmPaidPools'] : ['confirmPools'],
  };
}

export function assertPoolsAllowStop(
  impact: ListingImpact,
  caller: { permissions: string[] },
  confirmed: Partial<Record<PoolConfirmation, boolean>>,
): void {
  const gate = stopGateFor(impact, caller);
  if (gate.blocked) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: gate.blocked.message,
      meta: { pools: impact.pools },
    });
  }
  const missing = gate.needsConfirm.filter((flag) => confirmed[flag] !== true);
  if (missing.length > 0) {
    throw new AppError({
      code: 'CONFIRMATION_REQUIRED',
      messageEn: POOL_CONFIRM_MESSAGE[missing[0]!],
      field: missing[0]!,
      meta: {
        warnings: missing.map((flag) => ({
          key: flag === 'confirmPools' ? 'openPool' : 'paidPool',
          field: flag,
          message: POOL_CONFIRM_MESSAGE[flag],
        })),
        pools: impact.pools,
      },
    });
  }
}

/**
 * Tells the Admins which pools now need settling with their buyers, after a stop that went through on
 * `confirmPaidPools`. Pools by id, pack and boxes only — the notice names no buyer.
 */
async function tellDeskPoolsNeedSettling(
  pools: PoolRow[],
  productName: string,
  ctx: StopContext,
  session: ClientSession,
): Promise<void> {
  if (pools.length === 0) return;
  const recipients = [...new Set([ctx.employeeId, ...(await activeAdminIds())])];
  const described = pools
    .map(
      (pool) =>
        `${productName} ${pool.packLabel} (pool ${pool.poolId}): ${pool.boxesCommitted} boxes committed, ${pool.paidCommitments} paid`,
    )
    .join('; ');
  await notifyStaff(
    recipients,
    {
      kind: 'pool_needs_settling',
      title: `Pool needs settling: ${productName}`,
      body:
        `TriFid stopped a listing of ${productName} while a pool it supplies has paid commitments. ` +
        `The pool itself is unchanged and nobody has been told. Settle it with its buyers: ${described}.`,
      link: null,
    },
    session,
  );
}

/**
 * Step 1 of a stop and nothing else: the listing goes `paused`, tagged as staff's. One conditional
 * update, so a second stop (or a stop racing a quote withdrawal that stops the same line) finds
 * nothing to change. Returns whether this call changed it.
 */
async function pauseAsStopped(
  listingId: Types.ObjectId | string,
  ctx: StopContext,
  session: ClientSession,
): Promise<boolean> {
  const before = await Listing.findOneAndUpdate(
    { _id: listingId, state: { $in: ['live', 'paused'] }, stoppedBy: { $ne: 'staff' } },
    {
      $set: {
        state: 'paused',
        pausedAt: ctx.now,
        stoppedBy: 'staff',
        stoppedByEmployeeId: ctx.employeeId,
        stopReasonCode: ctx.reasonCode,
        stopNote: ctx.note,
        stopBatchId: ctx.stopBatchId,
      },
    },
    { session },
  );
  if (!before) return false;
  await writeAuditLog(
    {
      actorId: ctx.employeeId,
      actorType: 'staff',
      entity: 'listing',
      entityId: listingId,
      field: 'state',
      oldValue: before.state,
      newValue: 'paused (stopped by TriFid)',
      reason: reasonText(ctx),
      correlationId: ctx.correlationId,
    },
    session,
  );
  return true;
}

export interface StopOutcome {
  /** False when the listing was already stopped by staff: nothing was changed. */
  stopped: boolean;
  pilesClosed: number;
  quotesWithdrawn: number;
}

/**
 * The stop, in one transaction: the listing, its open piles, and its parked and live quotes.
 * Deals already offered to buyers (BR-378) and orders already raised are left alone. Open pools
 * are not touched. Used by the staff route and by the emergency script alike.
 */
export async function executeStop(
  listing: InstanceType<typeof Listing>,
  ctx: StopContext,
  /** Pools this seller supplies with a paid commitment, confirmed by an Admin: the Admins are told to settle them. */
  paidPools: PoolRow[] = [],
): Promise<StopOutcome> {
  const lines = await ListingLine.find({ listingId: listing._id }, { _id: 1 });
  const lineIds = lines.map((line) => line._id as Types.ObjectId);
  const productName = await productNameOf(listing.productId);
  return withTransaction(async (session) => {
    const changed = await pauseAsStopped(listing._id as Types.ObjectId, ctx, session);
    if (!changed) return { stopped: false, pilesClosed: 0, quotesWithdrawn: 0 };

    const { pilesClosed, toCall } = await declineOpenPiles(lineIds, ctx, session);
    await tellSalesToCall(toCall, productName, session);
    await tellDeskPoolsNeedSettling(paidPools, productName, ctx, session);

    // Any parked or live quote on these lines goes with the listing — whether the line was born for
    // the quote or was the seller's own that the quote reused. The listing is already stopped, so
    // no withdrawal needs to stop it again.
    const quotes = await Quote.find({
      listingLineId: { $in: lineIds },
      status: { $in: [...OPEN_QUOTE_STATUSES] },
    }).session(session);
    let quotesWithdrawn = 0;
    for (const quote of quotes) {
      const done = await withdrawQuoteInSession(quote._id as Types.ObjectId, ctx, session, {
        listingAlreadyStopped: true,
      });
      if (done.withdrawn) quotesWithdrawn += 1;
    }
    return { stopped: true, pilesClosed, quotesWithdrawn };
  });
}

/** The impact, and what this caller must do before the stop can go through (`gate`). */
export type StopPreview = ListingImpact & { gate: StopGate };

export type StopListingResult =
  | { confirmed: false; preview: StopPreview }
  | ({ confirmed: true; listingId: string; preview: StopPreview } & StopOutcome);

/** POST /staff/listings/:id/stop — the impact preview, or (with `confirm: true`) the stop. */
export async function stopListing(
  listingId: string,
  input: StopInput,
  caller: StopCaller,
): Promise<StopListingResult> {
  assertValidObjectId(listingId, 'listingId');
  const listing = await Listing.findById(listingId);
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
  if (listing.state === 'withdrawn') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This listing has been withdrawn already, so there is nothing to stop.',
    });
  }
  const now = new Date();
  const impact = await getListingImpact(listing, now);
  const preview: StopPreview = { ...impact, gate: stopGateFor(impact, caller) };
  if (input.confirm !== true) return { confirmed: false, preview };
  if (preview.alreadyStopped) {
    return {
      confirmed: true,
      listingId,
      preview,
      stopped: false,
      pilesClosed: 0,
      quotesWithdrawn: 0,
    };
  }
  assertPoolsAllowStop(preview, caller, input);
  const outcome = await executeStop(
    listing,
    {
      employeeId: caller.employeeId,
      correlationId: caller.correlationId,
      reasonCode: input.reasonCode,
      note: input.note,
      stopBatchId: null,
      now,
    },
    paidSuppliedPools(preview),
  );
  return { confirmed: true, listingId, preview, ...outcome };
}

/**
 * A line born for a quote exists for that one rate. Once the rate is withdrawn the line has nothing
 * behind it, so restarting it would put an all-India line at the old rate back on the board for 45
 * days, with no seller's quote under it. Such a line is restarted only while an open quote still
 * points at it; otherwise the seller quotes again (and Sales gives the rate again).
 */
export async function isQuoteBornWithoutOpenQuote(
  listing: InstanceType<typeof Listing>,
): Promise<boolean> {
  if (listing.origin !== 'quote_born') return false;
  const lines = await ListingLine.find({ listingId: listing._id }, { _id: 1 });
  const open = await Quote.exists({
    listingLineId: { $in: lines.map((line) => line._id) },
    status: { $in: [...OPEN_QUOTE_STATUSES] },
  });
  return !open;
}

/** What a restart reports for such a line: skipped, because the seller quotes again. */
export const SELLER_REQUOTES = 'seller re-quotes';

/**
 * POST /staff/listings/:id/restart — only staff lift a staff stop, and the listing gets a fresh
 * 45-day window as a seller's relist does (BR-108). A listing the seller paused himself is his to
 * relist, not staff's to restart; withdrawn quotes do not come back, and neither does a line that
 * was born for one (`isQuoteBornWithoutOpenQuote`): that is skipped and reported as `seller re-quotes`.
 */
export async function restartListing(
  listingId: string,
  input: { note?: string },
  caller: StopCaller,
): Promise<{ restarted: boolean; alreadyLive: boolean; skipped?: typeof SELLER_REQUOTES }> {
  assertValidObjectId(listingId, 'listingId');
  const listing = await Listing.findById(listingId);
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
  if (listing.state === 'live') return { restarted: false, alreadyLive: true };
  if (listing.state !== 'paused' || listing.stoppedBy !== 'staff') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn:
        listing.state === 'withdrawn'
          ? 'This listing has been withdrawn, so it cannot be restarted.'
          : 'TriFid did not stop this listing — the seller paused it, so he relists it himself.',
    });
  }
  if (await isQuoteBornWithoutOpenQuote(listing)) {
    return { restarted: false, alreadyLive: false, skipped: SELLER_REQUOTES };
  }
  // The same rule the seller's relist keeps (BR-370): a product no longer sold stays off the board.
  if (!(await isProductSellable(listing.productId as Types.ObjectId))) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This product is no longer sold on TriFid, so the listing cannot go live again.',
    });
  }
  const now = new Date();
  const restarted = await withTransaction(async (session) => {
    const before = await Listing.findOneAndUpdate(
      { _id: listing._id, state: 'paused', stoppedBy: 'staff' },
      {
        $set: {
          state: 'live',
          pausedAt: null,
          expiresAt: addDays(now, LISTING_LIFE_DAYS),
          dropReminderSentAt: null, // A fresh 45-day window earns a fresh reminder (BR-108).
          stoppedBy: null,
          stoppedByEmployeeId: null,
          stopReasonCode: null,
          stopNote: null,
          stopBatchId: null,
        },
      },
      { session },
    );
    if (!before) return false;
    await writeAuditLog(
      {
        actorId: caller.employeeId,
        actorType: 'staff',
        entity: 'listing',
        entityId: listing._id as Types.ObjectId,
        field: 'state',
        oldValue: 'paused (stopped by TriFid)',
        newValue: 'live',
        reason: input.note?.trim() || 'Restarted by staff.',
        correlationId: caller.correlationId,
      },
      session,
    );
    return true;
  });
  return { restarted, alreadyLive: false };
}

// ---------------------------------------------------------------------------
// Withdrawing a quote
// ---------------------------------------------------------------------------

export interface QuoteImpact {
  alreadyWithdrawn: boolean;
  quote: {
    quoteId: string;
    status: string;
    product: string;
    packLabel: string;
    sellerFirm: string;
    /** The seller's own net rate — Purchase's side of the wall; never a buyer's rate. */
    ratePaiseForIndore: number;
    qtyAvailable: number;
    bindingUntil: string;
  };
  /** What the withdrawal will do, so the person confirming knows. No buyer is named. */
  willHappen: {
    /** The buyer had been given this rate; Sales is told to call him. He is not messaged. */
    salesToldToCall: boolean;
    askReturnsToOpen: boolean;
    askStaysQuoted: boolean;
    rateChangeRequestsLapsed: number;
    /** Its quote-born listing line stops, because no other open quote points at it. */
    linePaused: boolean;
    /** The buyers' open piles on that line, which close as a desk decline when the line stops. Sales is told to call them. */
    pilesDeclined: number;
  };
  /** Piles open on the quote's line. They close with the line (`willHappen.pilesDeclined`); on a line that stays live they stay open. */
  openPilesOnLine: number;
  ordersUntouched: number;
}

/**
 * The listing a withdrawal stops with the quote: the one born for it, when no other open quote points
 * at it. `lineIds` is every line of that listing, because the whole listing is paused.
 */
async function lineStopPlan(
  quote: InstanceType<typeof Quote>,
  session?: ClientSession,
): Promise<{
  listingId: Types.ObjectId;
  productId: Types.ObjectId;
  lineIds: Types.ObjectId[];
} | null> {
  if (!quote.listingLineId) return null; // Older quotes were never published as a line.
  const line = await ListingLine.findById(quote.listingLineId).session(session ?? null);
  const listing = line ? await Listing.findById(line.listingId).session(session ?? null) : null;
  // Only a line born for a quote is stopped with it. The seller's own earlier line that the quote
  // reused is his, and stays on the board.
  if (!line || !listing || listing.origin !== 'quote_born') return null;
  const others = await Quote.exists({
    listingLineId: line._id,
    _id: { $ne: quote._id },
    status: { $in: [...OPEN_QUOTE_STATUSES] },
  }).session(session ?? null);
  if (others) return null;
  const lines = await ListingLine.find({ listingId: listing._id }, { _id: 1 }).session(
    session ?? null,
  );
  return {
    listingId: listing._id as Types.ObjectId,
    productId: listing.productId as Types.ObjectId,
    lineIds: lines.map((each) => each._id as Types.ObjectId),
  };
}

export async function getQuoteImpact(quote: InstanceType<typeof Quote>): Promise<QuoteImpact> {
  const ask = await Ask.findById(quote.askId, { skuId: 1, state: 1, buyerId: 1 });
  const skuId = quote.skuId ?? ask?.skuId ?? null;
  const sku = skuId ? await Sku.findById(skuId, { productId: 1, packLabel: 1 }) : null;
  const [product, seller] = await Promise.all([
    sku ? Product.findById(sku.productId, { brand: 1 }) : null,
    Seller.findById(quote.sellerId, { counterpartyId: 1 }),
  ]);
  const counterparty = seller
    ? await Counterparty.findById(seller.counterpartyId, { firm: 1 })
    : null;

  const wasLive = quote.status === 'live';
  const otherLive = wasLive
    ? await Quote.exists({ askId: quote.askId, _id: { $ne: quote._id }, status: 'live' })
    : null;
  const plan = await lineStopPlan(quote);
  const rateChanges = await RateChangeRequest.countDocuments({
    quoteId: quote._id,
    status: { $in: [...OPEN_RATE_CHANGE_STATUSES] },
  });
  const openPilesOnLine = quote.listingLineId
    ? await Pile.countDocuments({ listingLineId: quote.listingLineId, decision: null })
    : 0;
  const pilesDeclined = plan
    ? await Pile.countDocuments({ listingLineId: { $in: plan.lineIds }, decision: null })
    : 0;
  const ordersUntouched = await So.countDocuments({
    askId: quote.askId,
    sellerId: quote.sellerId,
    state: { $nin: FINISHED_ORDER_STATES },
  });

  return {
    alreadyWithdrawn: quote.status === 'withdrawn',
    quote: {
      quoteId: id(quote._id),
      status: quote.status,
      product: product?.brand ?? '',
      packLabel: sku?.packLabel ?? '',
      sellerFirm: counterparty?.firm ?? '',
      ratePaiseForIndore: quote.ratePaiseForIndore,
      qtyAvailable: quote.qtyAvailable,
      bindingUntil: quote.bindingUntil.toISOString(),
    },
    willHappen: {
      salesToldToCall: wasLive,
      askReturnsToOpen: wasLive && ask?.state === 'quoted' && !otherLive,
      askStaysQuoted: wasLive && ask?.state === 'quoted' && Boolean(otherLive),
      rateChangeRequestsLapsed: rateChanges,
      linePaused: plan !== null,
      pilesDeclined,
    },
    openPilesOnLine,
    ordersUntouched,
  };
}

/**
 * The withdrawal, inside the caller's transaction — used alone, and for each quote of a stopped
 * listing. One conditional update decides it, so two withdrawals at once cannot both win, and a
 * quote Sales has just taken (`won`) cannot be withdrawn. No strike, no rank.
 */
export async function withdrawQuoteInSession(
  quoteId: Types.ObjectId | string,
  ctx: StopContext,
  session: ClientSession,
  options: { listingAlreadyStopped?: boolean } = {},
): Promise<{ withdrawn: boolean; linePaused: boolean; pilesClosed: number }> {
  const before = await Quote.findOneAndUpdate(
    { _id: quoteId, status: { $in: [...OPEN_QUOTE_STATUSES] } },
    {
      $set: {
        status: 'withdrawn',
        withdrawnAt: ctx.now,
        withdrawnBy: ctx.employeeId,
        withdrawReasonCode: ctx.reasonCode,
        withdrawNote: ctx.note,
      },
    },
    { session },
  );
  if (!before) return { withdrawn: false, linePaused: false, pilesClosed: 0 };
  const wasLive = before.status === 'live';

  await writeAuditLog(
    {
      actorId: ctx.employeeId,
      actorType: 'staff',
      entity: 'quote',
      entityId: quoteId,
      field: 'status',
      oldValue: before.status,
      newValue: 'withdrawn',
      reason: reasonText(ctx),
      correlationId: ctx.correlationId,
    },
    session,
  );

  // Its open rate-change request(s) lapse — there is no longer a rate to change.
  const lapsing = await RateChangeRequest.find({
    quoteId,
    status: { $in: [...OPEN_RATE_CHANGE_STATUSES] },
  }).session(session);
  for (const request of lapsing) {
    const lapsed = await RateChangeRequest.updateOne(
      { _id: request._id, status: { $in: [...OPEN_RATE_CHANGE_STATUSES] } },
      { $set: { status: 'lapsed' } },
      { session },
    );
    if (lapsed.modifiedCount === 0) continue;
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'rate_change_request',
        entityId: request._id as Types.ObjectId,
        field: 'status',
        oldValue: request.status,
        newValue: 'lapsed',
        reason: 'The quote it was about was withdrawn.',
        correlationId: ctx.correlationId,
      },
      session,
    );
  }

  const ask = await Ask.findById(before.askId).session(session);
  if (wasLive && ask) {
    // The buyer had been given this rate. If it was the only one, the ask is open again and the
    // next quote starts a fresh round — the same settle a short fill makes.
    if (ask.state === 'quoted') {
      const oldState = ask.state;
      await settleAskAfterQuoteLeaves(ask, session);
      await syncEnquiryForAsk(ask._id as Types.ObjectId, session, ctx.now);
      if (ask.state !== oldState) {
        await writeAuditLog(
          {
            actorId: ctx.employeeId,
            actorType: 'staff',
            entity: 'ask',
            entityId: ask._id as Types.ObjectId,
            field: 'state',
            oldValue: oldState,
            newValue: ask.state,
            reason: 'The only live quote was withdrawn.',
            correlationId: ctx.correlationId,
          },
          session,
        );
      }
    }
    // No WhatsApp to the buyer: his one message a week is too valuable and the founder wants a call.
    const firm = await firmOfBuyer(ask.buyerId);
    const recipients = await salesDeskFor(ask.buyerId, activeAdminIds);
    await notifyStaff(
      recipients,
      {
        kind: 'rate_withdrawn',
        title: `Rate withdrawn: ${firm}`,
        body: `A rate given to ${firm} has been withdrawn. Call him.`,
        link: `/sales/buyers/${id(ask.buyerId)}`,
      },
      session,
    );
  }

  // The line born for this quote stops with it — and, as in a Stop, the buyers' open piles on it close
  // as a desk decline and Sales is told whom to ring. Left open they could still be confirmed, and the
  // fan-out would then give the buyers a 24-hour deal at the rate TriFid has just withdrawn. Deals
  // already offered are left to run, as with a Stop.
  let linePaused = false;
  let pilesClosed = 0;
  if (!options.listingAlreadyStopped) {
    const plan = await lineStopPlan(before, session);
    if (plan) {
      linePaused = await pauseAsStopped(plan.listingId, ctx, session);
      if (linePaused) {
        const closed = await declineOpenPiles(plan.lineIds, ctx, session);
        pilesClosed = closed.pilesClosed;
        await tellSalesToCall(closed.toCall, await productNameOf(plan.productId), session);
      }
    }
  }
  return { withdrawn: true, linePaused, pilesClosed };
}

export type WithdrawQuoteResult =
  | { confirmed: false; preview: QuoteImpact }
  | {
      confirmed: true;
      quoteId: string;
      preview: QuoteImpact;
      /** False when the quote was already withdrawn: nothing was changed. */
      withdrawn: boolean;
      linePaused: boolean;
      /** Open piles on the paused line, closed as a desk decline. */
      pilesClosed: number;
    };

/** POST /staff/quotes/:id/withdraw — the impact preview, or (with `confirm: true`) the withdrawal. */
export async function withdrawQuote(
  quoteId: string,
  input: Pick<StopInput, 'reasonCode' | 'note' | 'confirm'>,
  caller: StopCaller,
): Promise<WithdrawQuoteResult> {
  assertValidObjectId(quoteId, 'quoteId');
  const quote = await Quote.findById(quoteId);
  if (!quote) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Quote not found.' });
  if (
    quote.status !== 'withdrawn' &&
    !(OPEN_QUOTE_STATUSES as readonly string[]).includes(quote.status)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This quote has already closed, so it cannot be withdrawn.',
    });
  }
  const preview = await getQuoteImpact(quote);
  if (input.confirm !== true) return { confirmed: false, preview };
  if (preview.alreadyWithdrawn) {
    return {
      confirmed: true,
      quoteId,
      preview,
      withdrawn: false,
      linePaused: false,
      pilesClosed: 0,
    };
  }
  const outcome = await withTransaction((session) =>
    withdrawQuoteInSession(
      quoteId,
      {
        employeeId: caller.employeeId,
        correlationId: caller.correlationId,
        reasonCode: input.reasonCode,
        note: input.note,
        stopBatchId: null,
        now: new Date(),
      },
      session,
    ),
  );
  return { confirmed: true, quoteId, preview, ...outcome };
}
