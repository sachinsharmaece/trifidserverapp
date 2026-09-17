import type { Types } from 'mongoose';
import { Ask, ASK_STATES } from '../../models/Ask.js';
import { Quote, QUOTE_GAP_CODES, type QuoteGapCode } from '../../models/Quote.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import {
  ListingLine,
  type DeliveryBand,
  type ExpiryBand,
  type Provenance,
} from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Claim } from '../../models/Claim.js';
import { Config } from '../../models/Config.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { addHours, addWorkingHours } from '../../shared/clock.js';
import { assertCounterpartyActive } from '../../shared/guards.js';
import type { Paise } from '../../shared/money.js';
import { createSo } from '../chain/chain.service.js';
import { computeBuyerFacingRatePaise } from '../listing/listing.service.js';
import { recordPulseEvent } from '../desk/sales/sales.service.js';
import { getAgendaProducer, JOB_CONFIRM_PILE_FANOUT } from '../../worker/agendaProducer.js';
import { runConfirmPileFanout } from './pileFanout.job.js';

const OPEN_DEMAND_TTL_DAYS = 30; // BR-120.
const HEAD_START_HOURS = 4; // BR-122, working hours only (BR-231).
const BUYER_HOLD_HOURS = 24; // BR-126.
const UNDO_WINDOW_MS = 5000; // BR-137.

async function requireActiveBuyer(buyerCounterpartyId: string) {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  return buyer;
}

async function requireActiveSeller(sellerCounterpartyId: string) {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  return seller;
}

async function anyTrustedOrCommittedSellerExists(): Promise<boolean> {
  // BR-122 — "where no Trusted or Committed seller is in scope, the ask
  // opens to all immediately." Ask visibility is not territory-scoped
  // (only listings carry `frozenTehsilIds`), so "in scope" here reads as
  // "exists at all" — flagged as an inference, not a quoted Charter clause.
  const count = await Seller.countDocuments({ trustTier: { $in: ['Trusted', 'Committed'] } });
  return count > 0;
}

interface RaiseAskInput {
  skuId?: string;
  productId?: string;
  allPacks: boolean;
  qty: number;
  conditionRequirement: { expiryBand: ExpiryBand; deliveryBand?: DeliveryBand };
}

/** API-040. BR-121 — the buyer states no price; there is no price field to reject. */
export async function raiseAsk(
  buyerCounterpartyId: string,
  input: RaiseAskInput,
): Promise<{ askId: string }> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  await assertCounterpartyActive(buyerCounterpartyId); // QR-015 — blacklist blocks new asks.
  if (!input.skuId && !input.productId) {
    throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'A SKU or a product is required.' });
  }

  const now = new Date();
  const hasHeadStartSeller = await anyTrustedOrCommittedSellerExists();
  const visibleToAllAt = hasHeadStartSeller ? addWorkingHours(now, HEAD_START_HOURS) : now;

  const ask = await Ask.create({
    buyerId: buyer._id,
    skuId: input.skuId ?? null,
    productId: input.productId ?? null,
    allPacks: input.allPacks,
    qty: input.qty,
    conditionRequirement: input.conditionRequirement,
    visibleToAllAt,
    ttlAt: addHours(now, OPEN_DEMAND_TTL_DAYS * 24),
    state: 'open',
  });

  // BR-278/BR-279 — the market pulse. Organic (fromOurPush defaults false):
  // the buyer raised this on his own initiative, not because a desk called him.
  let pulseProductId = input.productId as unknown as Types.ObjectId | undefined;
  if (!pulseProductId && input.skuId) {
    const { Sku } = await import('../../models/Sku.js');
    const sku = await Sku.findById(input.skuId);
    pulseProductId = sku?.productId as Types.ObjectId | undefined;
  }
  if (pulseProductId) {
    await recordPulseEvent({
      buyerId: buyer._id as Types.ObjectId,
      productId: pulseProductId,
      kind: 'ask',
    });
  }

  return { askId: (ask._id as Types.ObjectId).toString() };
}

interface MyAskItem {
  askId: string;
  qty: number;
  state: string;
  ttlAt: Date;
  holdExpiresAt: Date | null;
  quotes: Array<{
    quoteId: string;
    ratePaiseForIndore: Paise | undefined; // This buyer's own tier rate — undefined only when not yet priceable.
    qtyAvailable: number;
    conditionSet: unknown;
    daysToIndore: number;
    status: string;
  }>;
}

/**
 * API-041. Quotes returned without seller identity — allocation is
 * computed server-side. BR-060 — `ratePaiseForIndore` on the `Quote`
 * document is the seller's net; this buyer is shown his own tier rate,
 * computed fresh, never that stored figure. An ask raised against a
 * specific SKU can be priced; a "any pack" ask has no single SKU to price
 * per-quote against yet, so its quotes carry no rate until the buyer
 * narrows to a SKU (flagged — not covered by a named business rule).
 */
export async function listMyAsks(buyerCounterpartyId: string): Promise<MyAskItem[]> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const asks = await Ask.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
  const quotes = await Quote.find({ askId: { $in: asks.map((a) => a._id) }, status: 'live' }).sort({
    ratePaiseForIndore: 1,
  });

  const quotesByAsk = new Map<string, typeof quotes>();
  for (const quote of quotes) {
    const key = (quote.askId as Types.ObjectId).toString();
    const list = quotesByAsk.get(key) ?? [];
    list.push(quote);
    quotesByAsk.set(key, list);
  }

  const items: MyAskItem[] = [];
  for (const ask of asks) {
    const askQuotes = quotesByAsk.get((ask._id as Types.ObjectId).toString()) ?? [];
    const quoteDtos = await Promise.all(
      askQuotes.map(async (q) => ({
        quoteId: (q._id as Types.ObjectId).toString(),
        ratePaiseForIndore: ask.skuId
          ? ((await computeBuyerFacingRatePaise(buyer, ask.skuId, q.ratePaiseForIndore)) ??
            undefined)
          : undefined,
        qtyAvailable: q.qtyAvailable,
        conditionSet: q.conditionSet,
        daysToIndore: q.daysToIndore,
        status: q.status,
      })),
    );
    items.push({
      askId: (ask._id as Types.ObjectId).toString(),
      qty: ask.qty,
      state: ask.state,
      ttlAt: ask.ttlAt,
      holdExpiresAt: ask.holdExpiresAt ?? null,
      quotes: quoteDtos,
    });
  }
  return items;
}

/** API-043. BR-130 — free, never a strike. */
export async function declineAsk(buyerCounterpartyId: string, askId: string): Promise<void> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const ask = await Ask.findOne({ _id: askId, buyerId: buyer._id });
  if (!ask) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
  ask.state = 'withdrawn';
  await ask.save();
}

interface AcceptFillInput {
  option: 'partial' | 'full';
  quoteIds: string[];
}

/** API-042. BR-127/BR-128 — a split fill is two trades; each seller's portion is its own chain. */
export async function acceptAskFill(
  buyerCounterpartyId: string,
  askId: string,
  input: AcceptFillInput,
  correlationId: string,
): Promise<{ soIds: string[] }> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const ask = await Ask.findOne({ _id: askId, buyerId: buyer._id });
  if (!ask) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });

  const quotes = await Quote.find({ _id: { $in: input.quoteIds }, askId: ask._id, status: 'live' });
  if (quotes.length !== input.quoteIds.length) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'One or more quotes are no longer live.',
    });
  }

  const soIds: string[] = [];
  const actor = { employeeId: (buyer._id as Types.ObjectId).toString(), correlationId };
  // BR-128 — independent chains: "where one leg fails the other stands" —
  // each seller's portion is its own transaction, not one shared one.
  for (const quote of quotes) {
    const result = await createSo(
      {
        buyerId: (buyer._id as Types.ObjectId).toString(),
        sellerId: (quote.sellerId as Types.ObjectId).toString(),
        skuId: (ask.skuId as Types.ObjectId | null)?.toString() ?? '',
        boxes: quote.qtyAvailable,
        sellerNetPaise: quote.ratePaiseForIndore,
        placeOfSupply: 'intra_state',
        askId: (ask._id as Types.ObjectId).toString(),
      },
      actor,
    );
    soIds.push(result.soId);
    quote.status = 'won';
    quote.rank = 1;
    await quote.save();
  }

  // BR-063 — every OTHER live quote on this ask closes with a rank only.
  const losers = await Quote.find({ askId: ask._id, status: 'live' });
  const rankedByPrice = [...quotes, ...losers].sort(
    (a, b) => a.ratePaiseForIndore - b.ratePaiseForIndore,
  );
  for (const loser of losers) {
    loser.status = 'lost';
    loser.rank =
      rankedByPrice.findIndex((q) =>
        (q._id as Types.ObjectId).equals(loser._id as Types.ObjectId),
      ) + 1;
    loser.ofCount = rankedByPrice.length;
    await loser.save();
  }

  ask.state = 'converted';
  await ask.save();

  return { soIds };
}

// ---------------------------------------------------------------------------
// Seller side — the demand board and quoting
// ---------------------------------------------------------------------------

export interface DemandBoardItem {
  askId: string;
  skuId?: string;
  productId?: string;
  allPacks: boolean;
  qty: number;
  conditionRequirement: unknown;
  headStart: boolean;
  visibleToAllAt: Date;
}

/** API-044. BR-064 — no tehsil, no district, ever, on any field of this response. */
export async function getDemandBoard(sellerCounterpartyId: string): Promise<DemandBoardItem[]> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const now = new Date();
  const isHeadStartSeller = seller.trustTier === 'Trusted' || seller.trustTier === 'Committed';

  const query: Record<string, unknown> = { state: 'open' };
  if (!isHeadStartSeller) query.visibleToAllAt = { $lte: now };

  const asks = await Ask.find(query).sort({ createdAt: -1 });
  return asks.map((ask) => ({
    askId: (ask._id as Types.ObjectId).toString(),
    skuId: ask.skuId ? (ask.skuId as Types.ObjectId).toString() : undefined,
    productId: ask.productId ? (ask.productId as Types.ObjectId).toString() : undefined,
    allPacks: ask.allPacks,
    qty: ask.qty,
    conditionRequirement: ask.conditionRequirement,
    headStart: isHeadStartSeller && ask.visibleToAllAt > now,
    visibleToAllAt: ask.visibleToAllAt,
  }));
}

interface PostQuoteInput {
  ratePaiseForIndore: Paise;
  qtyAvailable: number;
  expiryBand: ExpiryBand;
  expiryExact: string;
  deliveryBand: DeliveryBand;
  provenance: Provenance;
  batch?: string;
  daysToIndore: number;
}

function computeGapCodes(ask: InstanceType<typeof Ask>, input: PostQuoteInput): QuoteGapCode[] {
  const requirement = ask.conditionRequirement!;
  const gaps: QuoteGapCode[] = [];
  if (input.qtyAvailable < ask.qty) gaps.push('short_on_quantity');
  const expiryRank = { under12: 0, over12: 1 };
  if (expiryRank[input.expiryBand] < expiryRank[requirement.expiryBand as ExpiryBand]) {
    gaps.push('expiry_below_requirement');
  }
  if (requirement.deliveryBand) {
    const deliveryRank = { '48h': 0, '2-5d': 1 };
    if (deliveryRank[input.deliveryBand] > deliveryRank[requirement.deliveryBand as DeliveryBand]) {
      gaps.push('delivery_too_slow');
    }
  }
  return gaps;
}

/** API-045. BR-124 — no inbound freight field. BR-126 — starts the buyer's hold; never restarts it. */
export async function postQuote(
  sellerCounterpartyId: string,
  askId: string,
  input: PostQuoteInput,
): Promise<{ quoteId: string }> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  await assertCounterpartyActive(sellerCounterpartyId); // QR-015 — blacklist blocks new quotes.
  const ask = await Ask.findById(askId);
  if (!ask || ask.state === 'converted' || ask.state === 'withdrawn' || ask.state === 'lapsed') {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'This ask is no longer open.' });
  }

  if (input.provenance === 'auth' && !input.batch) {
    throw new AppError({
      code: 'BATCH_REQUIRED',
      messageEn: 'Batch is required for "My stock" (BR-105).',
    });
  }
  const allowedDelivery: Record<Provenance, DeliveryBand> = { auth: '48h', company: '2-5d' };
  if (allowedDelivery[input.provenance] !== input.deliveryBand) {
    throw new AppError({
      code: 'PROVENANCE_DELIVERY_MISMATCH',
      messageEn: `Provenance "${input.provenance}" only allows the "${allowedDelivery[input.provenance]}" delivery band.`,
    });
  }

  const now = new Date();
  const quote = await Quote.create({
    askId: ask._id,
    sellerId: seller._id,
    ratePaiseForIndore: input.ratePaiseForIndore,
    qtyAvailable: input.qtyAvailable,
    conditionSet: {
      expiryBand: input.expiryBand,
      expiryExact: input.expiryExact,
      deliveryBand: input.deliveryBand,
      provenance: input.provenance,
      batch: input.batch ?? null,
    },
    daysToIndore: input.daysToIndore,
    bindingUntil: addHours(now, BUYER_HOLD_HOURS),
    status: 'live',
    gapCodes: computeGapCodes(ask, input),
  });

  if (ask.state === 'open') {
    ask.state = 'quoted';
    if (!ask.holdExpiresAt) {
      ask.holdExpiresAt = addHours(now, BUYER_HOLD_HOURS); // BR-126 — first quote only, never restarts.
    }
    await ask.save();
  }

  return { quoteId: (quote._id as Types.ObjectId).toString() };
}

/** API-046. BR-063 — rank only on closed quotes; the winning rate is in no field. */
export async function listMyQuotes(
  sellerCounterpartyId: string,
): Promise<
  Array<{ quoteId: string; status: string; rank?: number; ofCount?: number; qtyAvailable: number }>
> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const quotes = await Quote.find({ sellerId: seller._id }).sort({ createdAt: -1 });
  return quotes.map((q) => ({
    quoteId: (q._id as Types.ObjectId).toString(),
    status: q.status,
    qtyAvailable: q.qtyAvailable,
    ...(q.status === 'lost' || q.status === 'won'
      ? { rank: q.rank ?? undefined, ofCount: q.ofCount ?? undefined }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// Piles and confirmation — WF-05
// ---------------------------------------------------------------------------

export interface PileQueueItem {
  pileId: string;
  listingLineId: string;
  totalQty: number;
  buyerCount: number;
  requests: Array<{ index: number; boxes: number; time: Date }>;
  meetsMoqOnOneTap: boolean;
}

/** API-048. Anonymised: index, boxes, time only — never identity, location or rate variation. */
export async function listConfirmations(sellerCounterpartyId: string): Promise<PileQueueItem[]> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const listings = await Listing.find({ sellerId: seller._id });
  const lines = await ListingLine.find({ listingId: { $in: listings.map((l) => l._id) } });
  const piles = await Pile.find({
    listingLineId: { $in: lines.map((l) => l._id) },
    decision: null,
  });

  const items: PileQueueItem[] = [];
  for (const pile of piles) {
    const line = lines.find((l) =>
      (l._id as Types.ObjectId).equals(pile.listingLineId as Types.ObjectId),
    )!;
    const requests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
    const totalQty = requests.reduce((sum, r) => sum + r.qty, 0);
    items.push({
      pileId: (pile._id as Types.ObjectId).toString(),
      listingLineId: (line._id as Types.ObjectId).toString(),
      totalQty,
      buyerCount: new Set(requests.map((r) => (r.buyerId as Types.ObjectId).toString())).size,
      requests: requests.map((r, index) => ({
        index: index + 1,
        boxes: r.qty,
        time: r.requestedAt,
      })),
      meetsMoqOnOneTap: totalQty >= line.moqExact,
    });
  }
  return items;
}

interface ConfirmPileInput {
  canSendBoxes: number;
  expiryExact: string;
  batch?: string;
}

/**
 * API-049. IC-21 — the exact-expiry and batch-when-`auth` gate applies on
 * every path that reaches this function, including the queue card's
 * one-tap shortcut; there is no second, looser code path.
 */
export async function confirmPile(
  sellerCounterpartyId: string,
  pileId: string,
  input: ConfirmPileInput,
  correlationId: string,
): Promise<{ pileId: string; undoWindowMs: number }> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const pile = await Pile.findById(pileId);
  if (!pile) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
  if (pile.decision) {
    throw new AppError({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: 'This pile has already been decided.',
    });
  }
  const line = await ListingLine.findById(pile.listingLineId);
  const listing = line
    ? await Listing.findOne({ _id: line.listingId, sellerId: seller._id })
    : null;
  if (!line || !listing)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });

  if (!input.expiryExact) {
    throw new AppError({
      code: 'EXPIRY_REQUIRED',
      messageEn: 'Exact expiry is required to confirm (BR-102).',
    });
  }
  if (line.provenance === 'auth' && !input.batch) {
    throw new AppError({
      code: 'BATCH_REQUIRED',
      messageEn: 'Batch is required for "My stock" listings (BR-105).',
    });
  }

  const requests = await PileRequest.find({ pileId: pile._id });
  const totalAsked = requests.reduce((sum, r) => sum + r.qty, 0);

  const now = new Date();
  pile.decision = 'confirmed';
  pile.decidedAt = now;
  pile.confirmedQty = Math.min(input.canSendBoxes, totalAsked);
  pile.expiryExact = input.expiryExact;
  pile.batch = input.batch ?? null;
  pile.sellerLockedUntil = addHours(now, 24); // BR-032.
  await pile.save();

  line.expiryFixed = true; // IC-01/BR-102 — the exact month may now display.
  line.expiryExact = input.expiryExact;
  await line.save();

  const agenda = getAgendaProducer();
  await agenda.schedule(new Date(now.getTime() + UNDO_WINDOW_MS), JOB_CONFIRM_PILE_FANOUT, {
    pileId,
  });

  await writeAuditLog({
    actorId: seller._id as Types.ObjectId,
    actorType: 'counterparty',
    entity: 'pile',
    entityId: pile._id as Types.ObjectId,
    field: 'decision',
    newValue: 'confirmed',
    correlationId,
  });

  return { pileId, undoWindowMs: UNDO_WINDOW_MS };
}

/** BR-137 — the undo half. Cancels the scheduled job before it ever fans out. */
export async function undoPileConfirm(sellerCounterpartyId: string, pileId: string): Promise<void> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const pile = await Pile.findById(pileId);
  if (!pile) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
  const line = await ListingLine.findById(pile.listingLineId);
  const listing = line
    ? await Listing.findOne({ _id: line.listingId, sellerId: seller._id })
    : null;
  if (!listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing line not found.' });

  if (pile.executedAt || Date.now() - (pile.decidedAt?.getTime() ?? 0) > UNDO_WINDOW_MS) {
    throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'The undo window has passed.' });
  }

  const agenda = getAgendaProducer();
  await agenda.cancel({ name: JOB_CONFIRM_PILE_FANOUT, data: { pileId } });

  pile.decision = null;
  pile.decidedAt = null;
  pile.confirmedQty = null;
  pile.sellerLockedUntil = null;
  await pile.save();
}

/** API-050 requote. Every buyer on the line is asked to accept or cancel — no strike, but scored. */
export async function requotePile(sellerCounterpartyId: string, pileId: string): Promise<void> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const pile = await Pile.findById(pileId);
  const line = pile ? await ListingLine.findById(pile.listingLineId) : null;
  const listing = line
    ? await Listing.findOne({ _id: line.listingId, sellerId: seller._id })
    : null;
  if (!pile || !listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
  if (pile.decision) {
    throw new AppError({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: 'This pile has already been decided.',
    });
  }
  pile.decision = 'requoted';
  pile.decidedAt = new Date();
  await pile.save();
}

/** API-050 decline. Free before payment (BR-035); listing line qty and pile are cleared. */
export async function declinePile(sellerCounterpartyId: string, pileId: string): Promise<void> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const pile = await Pile.findById(pileId);
  const line = pile ? await ListingLine.findById(pile.listingLineId) : null;
  const listing = line
    ? await Listing.findOne({ _id: line.listingId, sellerId: seller._id })
    : null;
  if (!pile || !listing) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
  if (pile.decision) {
    throw new AppError({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: 'This pile has already been decided.',
    });
  }
  pile.decision = 'declined';
  pile.decidedAt = new Date();
  await pile.save();
}

// ---------------------------------------------------------------------------
// Claim board — BR-139/BR-140, ships off behind config.claim_board.
// ---------------------------------------------------------------------------

export async function isClaimBoardEnabled(): Promise<boolean> {
  const config = await Config.findOne({ key: 'claim_board' });
  return config?.value === true;
}

async function assertClaimBoardEnabled(): Promise<void> {
  if (!(await isClaimBoardEnabled())) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Not found.' });
  }
}

export interface ClaimBoardItem {
  pileId: string;
  listingLineId: string;
  totalQty: number;
  ratePaise: Paise; // Same-line rate only — the buyer's rate may fall, never rise (BR-139).
}

/** API-051 GET. BR-139 — every other seller holding a live listing on the same product/SKU. */
export async function getClaimBoard(sellerCounterpartyId: string): Promise<ClaimBoardItem[]> {
  await assertClaimBoardEnabled();
  const seller = await requireActiveSeller(sellerCounterpartyId);

  const myListings = await Listing.find({ sellerId: seller._id, state: 'live' });
  const myLines = await ListingLine.find({ listingId: { $in: myListings.map((l) => l._id) } });
  const mySkuIds = [...new Set(myLines.map((l) => (l.skuId as Types.ObjectId).toString()))];

  const otherListings = await Listing.find({ sellerId: { $ne: seller._id }, state: 'live' });
  const otherLines = await ListingLine.find({
    listingId: { $in: otherListings.map((l) => l._id) },
    skuId: { $in: mySkuIds },
  });
  const undecidedPiles = await Pile.find({
    listingLineId: { $in: otherLines.map((l) => l._id) },
    decision: null,
  });
  const alreadyClaimed = await Claim.find({
    pileId: { $in: undecidedPiles.map((p) => p._id) },
    undoneAt: null,
  });
  const claimedPileIds = new Set(
    alreadyClaimed.map((c) => (c.pileId as Types.ObjectId).toString()),
  );

  const items: ClaimBoardItem[] = [];
  for (const pile of undecidedPiles) {
    if (claimedPileIds.has((pile._id as Types.ObjectId).toString())) continue;
    const line = otherLines.find((l) =>
      (l._id as Types.ObjectId).equals(pile.listingLineId as Types.ObjectId),
    )!;
    // BR-139 — the pile must meet the CLAIMING listing's own MOQ, not the original's.
    const myLine = myLines.find((l) =>
      (l.skuId as Types.ObjectId).equals(line.skuId as Types.ObjectId),
    );
    if (!myLine) continue;
    const requests = await PileRequest.find({ pileId: pile._id });
    const totalQty = requests.reduce((sum, r) => sum + r.qty, 0);
    if (totalQty < myLine.moqExact) continue;
    items.push({
      pileId: (pile._id as Types.ObjectId).toString(),
      listingLineId: (myLine._id as Types.ObjectId).toString(),
      totalQty,
      // BR-061's one named exception: the claim board shows the *stalled*
      // pile's own rate, another seller's, not the claiming seller's line.
      ratePaise: line.ratePaise,
    });
  }
  return items;
}

/** API-051 POST claim. First-come-wins via the database-level unique partial index. */
export async function claimPile(
  sellerCounterpartyId: string,
  pileId: string,
): Promise<{ claimId: string }> {
  await assertClaimBoardEnabled();
  const seller = await requireActiveSeller(sellerCounterpartyId);
  try {
    const claim = await Claim.create({ pileId, sellerId: seller._id, claimedAt: new Date() });
    return { claimId: (claim._id as Types.ObjectId).toString() };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    ) {
      throw new AppError({
        code: 'PILE_ALREADY_DECIDED',
        messageEn: 'Another seller already claimed this pile.',
      });
    }
    throw error;
  }
}

/** API-051 undo — BR-137, plain and immediate: nothing external has happened at claim time yet. */
export async function undoClaim(sellerCounterpartyId: string, claimId: string): Promise<void> {
  const seller = await requireActiveSeller(sellerCounterpartyId);
  const claim = await Claim.findOne({ _id: claimId, sellerId: seller._id });
  if (!claim) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Claim not found.' });
  claim.undoneAt = new Date();
  await claim.save();
}

export { ASK_STATES, QUOTE_GAP_CODES };
export { runConfirmPileFanout };
