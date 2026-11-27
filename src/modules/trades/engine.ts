import type { Request } from 'express';
import mongoose, { Types, isValidObjectId, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  BuyerModel,
  ListingModel,
  ProductModel,
  SkuModel,
  TradeEventModel,
  TradeModel,
  type Trade,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import {
  ASK_REASONS,
  type ActorRole,
  type BuyerStage,
  type SellerStage,
} from '../../shared/enums.js';
import {
  conflict,
  forbidden,
  invalidField,
  notFound,
  unauthenticated,
} from '../../shared/errors.js';
import { isDuplicateKeyError } from '../../shared/mongo.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { objectId } from '../parties/common.js';
import {
  DESK_NAMES,
  TRADE_ACTIONS,
  canPress,
  isAtStage,
  isTradeAction,
  type TradeActionName,
} from './actions.js';
import { COMMANDS, type TradeChange, type TradeDoc } from './commands.js';
import { BUYER_STAGE_LABELS } from './stages.js';
import { canSeeTrade } from './view.js';

/**
 * THE TRADE ENGINE (Q-WF-01, decided: one engine). The only code that creates or changes a trade.
 * Every change is one transaction: the trade (with `version` + 1), one history line (`trade_events`) and one
 * audit line. Routes and screens never write trades themselves.
 *
 * Checks, in this order (SRS-TRD-02): signed in (route) → the right desk (403) → the right stage (409) →
 * nobody changed it meanwhile (409 STALE_TRADE) → the input (422) → the business rules (409/422).
 */

interface Stages {
  buyerStage: BuyerStage;
  sellerStage?: SellerStage | null | undefined;
}

interface HistoryLine {
  action: string;
  before: Stages | null;
  after: Stages;
  buyerNote: string;
  sellerNote: string;
}

/** Who is acting: the signed-in person, or the system itself when a clock job made the request (Build 6). */
function actorOf(req: Request): { id?: string; role: ActorRole } {
  if (req.user) return { id: req.user.id, role: req.user.role };
  if (req.systemRun) return { role: 'SYSTEM' };
  throw unauthenticated();
}

/** Writes the history line and the audit line for one engine action (inside the same transaction). */
async function recordHistory(
  req: Request,
  trade: TradeDoc,
  line: HistoryLine,
  session: ClientSession,
) {
  const actor = actorOf(req);
  await TradeEventModel.create(
    [
      {
        tradeId: trade._id,
        action: line.action,
        ...(actor.id ? { actorId: actor.id } : {}),
        actorRole: actor.role,
        ...(line.before?.buyerStage ? { buyerStageBefore: line.before.buyerStage } : {}),
        ...(line.before?.sellerStage ? { sellerStageBefore: line.before.sellerStage } : {}),
        buyerStageAfter: line.after.buyerStage,
        ...(line.after.sellerStage ? { sellerStageAfter: line.after.sellerStage } : {}),
        ...(line.buyerNote ? { buyerNote: line.buyerNote } : {}),
        ...(line.sellerNote ? { sellerNote: line.sellerNote } : {}),
        requestId: req.requestId,
        at: new Date(),
      },
    ],
    { session },
  );
  await writeAudit(req, {
    action: `trade.${line.action}`,
    entityType: 'Trade',
    entityId: trade.id,
    before: line.before ? { ...line.before } : {},
    after: { ...line.after },
    session,
  });
}

const actionBody = z.object({ version: z.number().int().min(0) }).loose();

/**
 * POST /trades/:id/actions/:action  { version, ...input }  →  the changed trade.
 * `version` is the one the person was looking at; if someone else acted since, the answer is 409 STALE_TRADE.
 */
export async function runTradeAction(req: Request, tradeId: string, action: string, body: unknown) {
  const user = currentUserOf(req);
  if (!isTradeAction(action)) throw notFound('Unknown action.');
  const trade = isValidObjectId(tradeId) ? await TradeModel.findById(tradeId) : null;
  // A desk that may press this action may act from its queue even if it cannot open the card (Accounts).
  if (!trade || (!canSeeTrade(trade, user.role) && !canPress(user.role, action))) {
    throw notFound('Trade not found.');
  }

  const rule = TRADE_ACTIONS[action];
  if ('systemOnly' in rule) throw forbidden('The system does this when the time is up.');
  if (!canPress(user.role, action))
    throw forbidden(`${DESK_NAMES[rule.desk] ?? rule.desk} does this.`);
  if (!isAtStage(action, trade)) {
    throw conflict(
      `"${rule.label}" is not possible now: this trade is at ${BUYER_STAGE_LABELS[trade.buyerStage]}.`,
      'WRONG_STAGE',
    );
  }
  const { version, ...input } = actionBody.parse(body);
  if (version !== trade.version) throw staleTrade();
  return applyAction(req, trade, action, input, new Types.ObjectId(user.id));
}

/** Nobody: the `userId` a system run hands to commands. `silenceDelivery` writes no user into anything. */
const NO_USER_ID = new Types.ObjectId('000000000000000000000000');

/**
 * Runs the one action only the system presses, `silenceDelivery` (Build 6): the buyer's 7-day window ended and he
 * did not complain, so the deal counts as delivered. The history and audit lines say 'SYSTEM'. Throws a 409 when
 * the trade is no longer at the right stage or someone moved it first; the clock job skips those.
 */
export async function runSystemAction(tradeId: Types.ObjectId | string, action: 'silenceDelivery') {
  const trade = await TradeModel.findById(tradeId);
  if (!trade) throw notFound('Trade not found.');
  if (!isAtStage(action, trade)) {
    throw conflict(`This trade is at ${BUYER_STAGE_LABELS[trade.buyerStage]}.`, 'WRONG_STAGE');
  }
  const req = { requestId: `clock-${Date.now()}`, ip: '', systemRun: true } as unknown as Request;
  return applyAction(req, trade, action, {}, NO_USER_ID);
}

/** The checks are done: change the trade, write its history line and its audit line, all in one transaction. */
async function applyAction(
  req: Request,
  trade: TradeDoc,
  action: TradeActionName,
  input: Record<string, unknown>,
  userId: Types.ObjectId,
) {
  const now = new Date();
  await mongoose.connection.transaction(async (session) => {
    const change: TradeChange = await COMMANDS[action].run(
      { req, trade, userId, now, session },
      input,
    );
    const before = { buyerStage: trade.buyerStage, sellerStage: trade.sellerStage };
    // Only update if nobody changed the trade since it was loaded (same version).
    const result = await TradeModel.updateOne(
      { _id: trade._id, version: trade.version },
      {
        $set: { ...change.set, lastActionAt: now },
        $inc: { version: 1 },
        ...(change.unset?.length
          ? { $unset: Object.fromEntries(change.unset.map((field) => [field, 1])) }
          : {}),
      },
      { session, runValidators: true },
    );
    if (result.matchedCount !== 1) throw staleTrade();
    const after = await TradeModel.findById(trade._id).session(session).orFail();
    await recordHistory(
      req,
      trade,
      {
        action,
        before,
        after: { buyerStage: after.buyerStage, sellerStage: after.sellerStage },
        buyerNote: change.buyerNote,
        sellerNote: change.sellerNote,
      },
      session,
    );
  });
  return TradeModel.findById(trade._id).orFail();
}

function staleTrade() {
  return conflict('Someone else changed this trade. Reload it and try again.', 'STALE_TRADE');
}

/** A buyer who exists and is turned on (Sales may only open trades for active buyers). */
async function activeBuyer(buyerId: string) {
  const buyer = await BuyerModel.findById(buyerId);
  if (!buyer) throw invalidField('buyerId', 'Buyer not found.');
  if (!buyer.active) throw conflict('This buyer is turned off.', 'BUYER_INACTIVE');
  return buyer;
}

/** Creates a trade (number, history line, audit line) in one transaction. */
async function createTrade(
  req: Request,
  fields: Omit<Partial<Trade>, 'number'>,
  history: Omit<HistoryLine, 'before'>,
) {
  const user = currentUserOf(req);
  return mongoose.connection.transaction(async (session) => {
    const now = new Date();
    const number = await nextDocumentNumber('TRADE', { session, at: now });
    const [trade] = await TradeModel.create(
      [
        {
          ...fields,
          number,
          ownerUserId: new Types.ObjectId(user.id),
          lastActionAt: now,
          version: 0,
        },
      ],
      { session },
    );
    if (!trade) throw new Error('Trade was not created.');
    await recordHistory(req, trade, { ...history, before: null }, session);
    return trade;
  });
}

export const openViewingBody = z.object({ buyerId: objectId, listingId: objectId });

/**
 * Sales opens a rate-board row for a buyer → a trade at b1 (Viewing). Opening the same row again returns the
 * same b1 trade instead of a new one (BR-23). Returns `created: false` in that case.
 */
export async function openViewing(req: Request, body: unknown) {
  const input = openViewingBody.parse(body);
  await activeBuyer(input.buyerId);
  const listing = await ListingModel.findById(input.listingId);
  const sku = listing ? await SkuModel.findById(listing.skuId) : null;
  const product = sku ? await ProductModel.findById(sku.productId) : null;
  const live = listing?.status === 'ACTIVE' && listing.expiresAt > new Date();
  if (!listing || !live || !sku?.active || !product?.active) {
    throw conflict('This offer is no longer on the board.', 'LISTING_UNAVAILABLE');
  }

  const open = {
    buyerId: input.buyerId,
    listingId: listing._id,
    buyerStage: 'B1_VIEWING' as const,
  };
  const existing = await TradeModel.findOne(open);
  if (existing) return { trade: existing, created: false };
  try {
    const trade = await createTrade(
      req,
      {
        source: 'LISTED',
        buyerId: new Types.ObjectId(input.buyerId),
        productId: product._id,
        skuId: sku._id,
        listingId: listing._id,
        buyerStage: 'B1_VIEWING',
      },
      {
        action: 'openViewing',
        after: { buyerStage: 'B1_VIEWING' },
        // The history label already says "Opened from the rate board".
        buyerNote: '',
        sellerNote: '',
      },
    );
    return { trade, created: true };
  } catch (error) {
    // Two clicks at the same moment: the unique index lets only one b1 in; return that one.
    if (isDuplicateKeyError(error)) {
      const winner = await TradeModel.findOne(open);
      if (winner) return { trade: winner, created: false };
    }
    throw error;
  }
}

export const askBody = z
  .object({
    buyerId: objectId,
    productId: objectId,
    skuId: objectId.optional(),
    boxes: z.number().int().min(1, 'Enter at least 1 box').max(1_000_000),
    reason: z.enum(ASK_REASONS, 'Choose why the buyer is asking'),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((text) => text || undefined),
  })
  .refine((value) => value.reason !== 'OTHER' || value.note, {
    path: ['note'],
    message: 'Write a short note for "Other"',
  });

/**
 * Sales records an ask for something not on the board → a trade at b2 (Inquiry), source NOT_LISTED.
 * "Send to seller" then sends it to Purchase to find a seller (s0).
 */
export async function askNotListed(req: Request, body: unknown) {
  const input = askBody.parse(body);
  await activeBuyer(input.buyerId);
  const product = await ProductModel.findById(input.productId);
  if (!product?.active) throw invalidField('productId', 'Choose an active product.');
  const sku = input.skuId ? await SkuModel.findById(input.skuId) : null;
  if (input.skuId && (!sku?.active || !sku.productId.equals(product._id))) {
    throw invalidField('skuId', 'Choose an active pack of this product.');
  }
  return createTrade(
    req,
    {
      source: 'NOT_LISTED',
      buyerId: new Types.ObjectId(input.buyerId),
      productId: product._id,
      ...(sku ? { skuId: sku._id } : {}),
      buyerStage: 'B2_INQUIRY',
      boxesWanted: input.boxes,
      ask: { reason: input.reason, ...(input.note ? { note: input.note } : {}) },
    },
    {
      action: 'askNotListed',
      after: { buyerStage: 'B2_INQUIRY' },
      buyerNote: `Asked for ${input.boxes} boxes`,
      sellerNote: '',
    },
  );
}
