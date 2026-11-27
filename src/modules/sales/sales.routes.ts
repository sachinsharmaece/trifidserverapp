import { Router } from 'express';
import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import {
  BuyerModel,
  CallLogModel,
  ProductModel,
  SkuModel,
  TradeModel,
  UserModel,
} from '../../models/index.js';
import {
  ASK_REASONS,
  CALL_OUTCOMES,
  type BuyerStage,
  type SellerStage,
} from '../../shared/enums.js';
import { invalidField } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { canUseBuyers } from '../parties/permissions.js';
import { askNotListed } from '../trades/engine.js';

/**
 * The reference's Sales-desk extras (reference-copy branch): the call log and the Asks list.
 *
 *   GET  /call-logs                      { callLogs }  newest first (200)
 *   POST /call-logs { buyerId, productId?, skuId?, outcome, note?, quantity?, reasonCode? }  -> 201 { callLog }
 *        ASKED_FOR_RATE also records an ask (a NOT_LISTED trade); WANTS_IT needs the pack.
 *   GET  /asks                           { asks }  every NOT_LISTED trade, newest first (200)
 *   POST /asks { buyerId, productId, skuId?, quantity, reasonCode, conditionNote? }  -> 201 { ask }
 */
export const salesRouter: Router = Router();
salesRouter.use(['/call-logs', '/asks'], requireAuth, canUseBuyers);

const objectId = z.string().refine(isValidObjectId, 'Select a valid item');

const callBody = z.object({
  buyerId: objectId,
  productId: objectId.optional(),
  skuId: objectId.optional(),
  outcome: z.enum(CALL_OUTCOMES, 'Select a call outcome'),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((t) => t || undefined),
  quantity: z.number().int().positive().max(1_000_000).optional(),
  reasonCode: z.enum(ASK_REASONS).optional(),
});

const askInput = z.object({
  buyerId: objectId,
  productId: objectId,
  skuId: objectId.optional(),
  quantity: z.number().int().positive('Quantity must be a positive whole number'),
  reasonCode: z.enum(ASK_REASONS, 'Select a reason'),
  conditionNote: z.string().optional(),
});

/** Where an ask stands, in the reference's words, from the trade's stages. */
function askStatus(buyerStage: BuyerStage, sellerStage: SellerStage | null | undefined) {
  if (buyerStage === 'B2_INQUIRY') return 'OPEN';
  if (buyerStage === 'B3_PENDING_SELLER')
    return sellerStage === 'S1_CONFIRMATION' ? 'MATCHED' : 'OPEN';
  if (buyerStage === 'B4_SEND_CONFIRMATION' || buyerStage === 'B5_BUYERS_CALL') return 'CONFIRMED';
  return 'CLOSED';
}

async function askRows(filter: Record<string, unknown>) {
  const trades = await TradeModel.find({ source: 'NOT_LISTED', ...filter })
    .sort({ createdAt: -1 })
    .limit(500);
  const [buyers, products, skus] = await Promise.all([
    BuyerModel.find({ _id: { $in: trades.map((t) => t.buyerId) } }, { firmName: 1 }),
    ProductModel.find({ _id: { $in: trades.map((t) => t.productId) } }, { name: 1 }),
    SkuModel.find(
      { _id: { $in: trades.flatMap((t) => (t.skuId ? [t.skuId] : [])) } },
      { packLabel: 1 },
    ),
  ]);
  return trades.map((t) => {
    const sku = t.skuId ? skus.find((s) => s._id.equals(t.skuId)) : undefined;
    return {
      id: t.id,
      tradeId: t.id,
      humanCode: t.number,
      buyer: {
        id: String(t.buyerId),
        name: buyers.find((b) => b._id.equals(t.buyerId))?.firmName ?? '',
      },
      product: { name: products.find((p) => p._id.equals(t.productId))?.name ?? '' },
      sku: sku ? { packLabel: sku.packLabel } : null,
      quantity: t.boxesWanted ?? 0,
      reasonCode: t.ask?.reason ?? null,
      status: askStatus(t.buyerStage, t.sellerStage),
      createdAt: t.createdAt,
    };
  });
}

salesRouter.get('/asks', async (_req, res) => {
  res.json({ asks: await askRows({}) });
});

salesRouter.post('/asks', async (req, res) => {
  const input = askInput.parse(req.body);
  const trade = await askNotListed(req, {
    buyerId: input.buyerId,
    productId: input.productId,
    ...(input.skuId ? { skuId: input.skuId } : {}),
    boxes: input.quantity,
    reason: input.reasonCode,
    ...(input.conditionNote?.trim() ? { note: input.conditionNote.trim() } : {}),
  });
  const [ask] = await askRows({ _id: trade._id });
  res.status(201).json({ ask });
});

async function callRows(limit: number, filter: Record<string, unknown> = {}) {
  const logs = await CallLogModel.find(filter).sort({ createdAt: -1 }).limit(limit);
  const [buyers, products, users] = await Promise.all([
    BuyerModel.find({ _id: { $in: logs.map((l) => l.buyerId) } }, { firmName: 1 }),
    ProductModel.find(
      { _id: { $in: logs.flatMap((l) => (l.productId ? [l.productId] : [])) } },
      { name: 1 },
    ),
    UserModel.find({ _id: { $in: logs.map((l) => l.by) } }, { name: 1 }),
  ]);
  return logs.map((log) => {
    const product = log.productId ? products.find((p) => p._id.equals(log.productId)) : undefined;
    return {
      id: log.id,
      buyer: {
        id: String(log.buyerId),
        name: buyers.find((b) => b._id.equals(log.buyerId))?.firmName ?? '',
      },
      product: product ? { id: product.id, name: product.name } : null,
      outcome: log.outcome,
      note: log.note ?? null,
      by: users.find((u) => u._id.equals(log.by))?.name ?? '',
      createdAt: log.createdAt,
    };
  });
}

salesRouter.get('/call-logs', async (_req, res) => {
  res.json({ callLogs: await callRows(200) });
});

salesRouter.post('/call-logs', async (req, res) => {
  const input = callBody.parse(req.body);
  const buyer = await BuyerModel.findById(input.buyerId);
  if (!buyer) throw invalidField('buyerId', 'Select a buyer');

  let tradeId: Types.ObjectId | undefined;
  if (input.outcome === 'ASKED_FOR_RATE') {
    if (!input.productId) throw invalidField('productId', 'Select a product');
    if (!input.quantity) throw invalidField('quantity', 'Enter a quantity');
    if (!input.reasonCode) throw invalidField('reasonCode', 'Select a reason');
    const trade = await askNotListed(req, {
      buyerId: input.buyerId,
      productId: input.productId,
      ...(input.skuId ? { skuId: input.skuId } : {}),
      boxes: input.quantity,
      reason: input.reasonCode,
    });
    tradeId = trade._id;
  }
  if (input.outcome === 'WANTS_IT' && !input.skuId) {
    throw invalidField('skuId', 'Select the product and pack the buyer wants');
  }

  const log = await CallLogModel.create({
    buyerId: buyer._id,
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.skuId ? { skuId: input.skuId } : {}),
    outcome: input.outcome,
    ...(input.note ? { note: input.note } : {}),
    ...(input.quantity ? { quantity: input.quantity } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(tradeId ? { tradeId } : {}),
    by: currentUserOf(req).id,
  });
  const [callLog] = await callRows(1, { _id: log._id });
  res.status(201).json({ callLog });
});
