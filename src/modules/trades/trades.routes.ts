import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { BuyerModel, ProductModel, SellerModel, TradeModel } from '../../models/index.js';
import { BUYER_STAGES, SELLER_STAGES, type Role } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import {
  BUYER_SIDE_ROLES,
  SELLER_SIDE_ROLES,
  canUseBuyers,
  canUseSellers,
} from '../parties/permissions.js';
import { pagingShape } from '../parties/common.js';
import { PRESS_ANY_BUTTON_ROLES } from './actions.js';
import type { TradeDoc } from './commands.js';
import { askNotListed, openViewing, runTradeAction } from './engine.js';
import { canSeeTrade, tradeRows, tradeView } from './view.js';

/**
 * Trades (deal cards and funnel lists). Every write goes to the trade engine (engine.ts); this file only reads
 * and passes requests on. Accounts and Logistics have no trade screens yet (403).
 */
export const tradesRouter: Router = Router();

const anySide: Role[] = [...new Set([...BUYER_SIDE_ROLES, ...SELLER_SIDE_ROLES])];
tradesRouter.use('/trades', requireAuth, requireRole(...anySide));

/** Who may start a trade from the rate board: Sales, and Founder/Admin (they have every right). */
const startsTrades = requireRole('SALES', ...PRESS_ANY_BUTTON_ROLES);

/** POST /trades/open-viewing { buyerId, listingId } → 201 { trade } (or 200 with the open one). */
tradesRouter.post('/trades/open-viewing', startsTrades, async (req, res) => {
  const { trade, created } = await openViewing(req, req.body);
  res.status(created ? 201 : 200).json({ trade: await tradeView(trade, req.user!.role) });
});

/** POST /trades/asks { buyerId, productId, skuId?, boxes, reason, note? } → 201 { trade } at b2. */
tradesRouter.post('/trades/asks', startsTrades, async (req, res) => {
  const trade = await askNotListed(req, req.body);
  res.status(201).json({ trade: await tradeView(trade, req.user!.role) });
});

const listQuery = z.object({ ...pagingShape, stage: z.string().optional() });

/**
 * Shared by the two funnel lists. Returns the page of trades (who must act soonest first) plus counts per stage.
 * Loads the matching open trades and pages them in memory, which is fine for a few thousand trades.
 */
async function funnelList(side: 'buyer' | 'seller', query: unknown, stages: readonly string[]) {
  const { q, page, pageSize, stage } = listQuery.parse(query);
  const stageField = side === 'buyer' ? 'buyerStage' : 'sellerStage';
  const base: Record<string, unknown> = { [stageField]: { $in: stages } };
  if (q) {
    const pattern = { $regex: escapeRegex(normaliseKey(q)) };
    const products = await ProductModel.find({ nameLower: pattern }).select('_id');
    const parties =
      side === 'buyer'
        ? await BuyerModel.find({ firmKey: pattern }).select('_id')
        : await SellerModel.find({ firmKey: pattern }).select('_id');
    base.$or = [
      { number: { $regex: escapeRegex(q.toUpperCase()) } },
      { productId: { $in: products.map((p) => p._id) } },
      { [side === 'buyer' ? 'buyerId' : 'sellerId']: { $in: parties.map((p) => p._id) } },
    ];
  }
  const counts: Record<string, number> = {};
  for (const name of stages)
    counts[name] = await TradeModel.countDocuments({ ...base, [stageField]: name });

  const filter = stage && stages.includes(stage) ? { ...base, [stageField]: stage } : base;
  const trades: TradeDoc[] = await TradeModel.find(filter);
  // Soonest due first; trades with no clock after them, the most recently touched first.
  trades.sort(
    (a, b) =>
      (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
      b.lastActionAt.getTime() - a.lastActionAt.getTime(),
  );
  const pageOf = trades.slice((page - 1) * pageSize, page * pageSize);
  return { counts, trades: await tradeRows(pageOf, side), total: trades.length, page, pageSize };
}

/** GET /trades/buyer-side?stage&q&page&pageSize → Buyer funnels (Sales and supervisors). */
tradesRouter.get('/trades/buyer-side', canUseBuyers, async (req, res) => {
  res.json(await funnelList('buyer', req.query, BUYER_STAGES));
});

/** GET /trades/seller-side?stage&q&page&pageSize → Seller funnels, Purchase's queue (Purchase and supervisors). */
tradesRouter.get('/trades/seller-side', canUseSellers, async (req, res) => {
  res.json(await funnelList('seller', req.query, SELLER_STAGES));
});

/** GET /trades/:id → { trade } as the signed-in person may see it. */
tradesRouter.get('/trades/:id', async (req, res) => {
  const role = req.user!.role;
  const trade = isValidObjectId(req.params.id) ? await TradeModel.findById(req.params.id) : null;
  if (!trade || !canSeeTrade(trade, role)) throw notFound('Trade not found.');
  res.json({ trade: await tradeView(trade, role) });
});

/** POST /trades/:id/actions/:action { version, ...input } → { trade }. The engine checks everything. */
tradesRouter.post('/trades/:id/actions/:action', async (req, res) => {
  const trade = await runTradeAction(req, req.params.id, req.params.action, req.body);
  res.json({ trade: await tradeView(trade, req.user!.role) });
});
