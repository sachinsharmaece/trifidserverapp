import { Router } from 'express';
import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import {
  ListingModel,
  ProductModel,
  PurchaseOrderModel,
  SalesOrderModel,
  SkuModel,
  TradeModel,
} from '../../models/index.js';
import { PARTY_TYPES, type BuyerStage, type SellerStage } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { verifyOtp, requestOtp } from './otp.js';
import {
  endPartySession,
  findPartySession,
  partyOf,
  requirePartySession,
  startPartySession,
} from './session.js';

/**
 * The buyer and seller portals (reference app/api/portal/*). A firm's own people sign in with their mobile number
 * and a one-time code, and see their own records only: every query below is filtered by the signed-in firm's id
 * (never a lookup by record id alone). Nothing here shows the other side of the wall: a buyer never sees the seller
 * or the seller's rate, a seller never sees the buyer or our selling rate, and staff notes are never shown.
 *
 *   POST /portal/otp/request   { partyType, mobile }          ->  { message } (the same whether or not it has a login)
 *   POST /portal/otp/verify    { partyType, mobile, otp }     ->  { ok } and the portal cookie
 *   POST /portal/logout
 *   GET  /portal/me                                           ->  { party } or 401 (the app's login check)
 *   GET  /portal/buyer/asks | /portal/buyer/confirmations | /portal/buyer/sales-orders | /portal/buyer/sales-orders/:id
 *   GET  /portal/seller/listings | /portal/seller/confirmations | /portal/seller/purchase-orders
 *
 * "Confirmations" are our trades sent to a seller: PENDING while the seller has not answered, CONFIRMED once he
 * has. A seller's "no" sends the trade back to Purchase without the seller, so it is not listed (the reference
 * keeps a DECLINED row).
 */
export const portalRouter: Router = Router();

const loginBody = z.object({
  partyType: z.enum(PARTY_TYPES),
  mobile: z.string().min(1, 'Enter a mobile number'),
});

portalRouter.post('/portal/otp/request', async (req, res) => {
  const body = loginBody.parse(req.body);
  res.json(await requestOtp(body.partyType, body.mobile.trim()));
});

portalRouter.post('/portal/otp/verify', async (req, res) => {
  const body = loginBody.extend({ otp: z.string().min(1, 'Enter the code') }).parse(req.body);
  const account = await verifyOtp(body.partyType, body.mobile.trim(), body.otp.trim());
  await startPartySession(res, account);
  res.json({ ok: true });
});

portalRouter.post('/portal/logout', async (req, res) => {
  await endPartySession(req, res);
  res.json({ ok: true });
});

portalRouter.get('/portal/me', async (req, res) => {
  const party = await findPartySession(req);
  if (!party) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: req.requestId },
    });
    return;
  }
  res.json({ party: { partyType: party.partyType } });
});

// ---------- shared lookups ----------

async function namesFor(productIds: Types.ObjectId[], skuIds: Types.ObjectId[]) {
  const [products, skus] = await Promise.all([
    ProductModel.find({ _id: { $in: productIds } }, { name: 1 }),
    SkuModel.find({ _id: { $in: skuIds } }, { packLabel: 1, productId: 1 }),
  ]);
  return {
    product: (id: Types.ObjectId | null | undefined) =>
      id ? (products.find((p) => p._id.equals(id))?.name ?? null) : null,
    sku: (id: Types.ObjectId | null | undefined) =>
      id ? (skus.find((s) => s._id.equals(id)) ?? null) : null,
  };
}

/** Where an ask stands, in the reference's words (the same rule as the Sales Asks page). */
function askStatus(buyerStage: BuyerStage, sellerStage: SellerStage | null | undefined) {
  if (buyerStage === 'B2_INQUIRY') return 'OPEN';
  if (buyerStage === 'B3_PENDING_SELLER') {
    return sellerStage === 'S1_CONFIRMATION' ? 'MATCHED' : 'OPEN';
  }
  if (buyerStage === 'B4_SEND_CONFIRMATION' || buyerStage === 'B5_BUYERS_CALL') return 'CONFIRMED';
  return 'CLOSED';
}

type TradeDoc = InstanceType<typeof TradeModel>;

/** Trades sent to a seller, as "confirmations". `side` decides which side's fields are shown. */
async function confirmationRows(trades: TradeDoc[], side: 'BUYER' | 'SELLER') {
  const names = await namesFor(
    trades.map((t) => t.productId),
    trades.flatMap((t) => (t.skuId ? [t.skuId] : [])),
  );
  return trades.map((t) => {
    const answer = t.sellerAnswer;
    const common = {
      id: t.id,
      source: t.source === 'NOT_LISTED' ? 'ASK' : 'LISTING_TAKE',
      status: answer ? 'CONFIRMED' : 'PENDING',
      product: names.product(t.productId),
      pack: names.sku(t.skuId)?.packLabel ?? null,
      quantityBoxes: t.boxesWanted ?? 0,
      confirmedBoxes: answer?.boxes ?? null,
      confirmedExpiryMonth: answer?.expiryMonth ?? null,
      createdAt: (t as unknown as { createdAt: Date }).createdAt,
    };
    // The seller also sees his own batch number; neither side sees the other's name or rate.
    return side === 'SELLER' ? { ...common, batchNumber: answer?.batchNumber ?? null } : common;
  });
}

// ---------- buyer portal ----------

const buyerOnly = requirePartySession('BUYER');
const sellerOnly = requirePartySession('SELLER');
const ownBuyer = (req: Parameters<typeof partyOf>[0]) => partyOf(req).buyerId;
const ownSeller = (req: Parameters<typeof partyOf>[0]) => partyOf(req).sellerId;

portalRouter.get('/portal/buyer/asks', buyerOnly, async (req, res) => {
  const trades = await TradeModel.find({ buyerId: ownBuyer(req), source: 'NOT_LISTED' })
    .sort({ createdAt: -1 })
    .limit(500);
  const names = await namesFor(
    trades.map((t) => t.productId),
    trades.flatMap((t) => (t.skuId ? [t.skuId] : [])),
  );
  res.json({
    asks: trades.map((t) => ({
      id: t.id,
      humanCode: t.number,
      product: names.product(t.productId) ?? '',
      pack: names.sku(t.skuId)?.packLabel ?? null,
      quantity: t.boxesWanted ?? 0,
      reasonCode: t.ask?.reason ?? null,
      // The ask's note is written by Sales: not shown back (the reference shows its condition note).
      status: askStatus(t.buyerStage, t.sellerStage),
      createdAt: (t as unknown as { createdAt: Date }).createdAt,
    })),
  });
});

portalRouter.get('/portal/buyer/confirmations', buyerOnly, async (req, res) => {
  const trades = await TradeModel.find({
    buyerId: ownBuyer(req),
    sellerId: { $exists: true },
    sellerStage: { $exists: true },
  })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({ confirmations: await confirmationRows(trades, 'BUYER') });
});

type SalesOrderDoc = InstanceType<typeof SalesOrderModel>;

/** The buyer's own order: his rates and totals only, never our buying rate or the seller. */
function salesOrderView(so: SalesOrderDoc) {
  return {
    id: so.id,
    humanNumber: so.number,
    status: so.status,
    deliveryLocation: so.buyerSnapshot?.deliveryLocation ?? null,
    insuranceElected: so.insurance?.elected ?? false,
    totalPaise: so.totalPaise,
    totalDisplay: formatRupees(so.totalPaise),
    paymentWindowDeadline: so.paymentDueAt,
    cancelledAt: so.cancel?.at ?? null,
    cancelReason: so.cancel?.reasonLabel ?? null,
    deliveryConfirmedAt: so.deliveredAt ?? null,
    createdAt: (so as unknown as { createdAt: Date }).createdAt,
    lines: so.lines.map((line) => ({
      id: `${so.id}-${line.lineNo}`,
      product: line.productName,
      pack: line.packLabel,
      boxes: line.boxes,
      ratePaisePerBaseUnit: line.buyerRatePaisePerUnit,
      boxValuePaise: line.boxValuePaise,
      boxValueDisplay: formatRupees(line.boxValuePaise),
    })),
  };
}

portalRouter.get('/portal/buyer/sales-orders', buyerOnly, async (req, res) => {
  const orders = await SalesOrderModel.find({ buyerId: ownBuyer(req) })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({ salesOrders: orders.map(salesOrderView) });
});

portalRouter.get('/portal/buyer/sales-orders/:id', buyerOnly, async (req, res) => {
  // The firm's own id is part of the query itself, so another buyer's order is simply "not found".
  const so = isValidObjectId(req.params.id)
    ? await SalesOrderModel.findOne({ _id: req.params.id, buyerId: ownBuyer(req) })
    : null;
  if (!so) throw notFound('Not found');
  res.json({ salesOrder: salesOrderView(so) });
});

// ---------- seller portal ----------

portalRouter.get('/portal/seller/listings', sellerOnly, async (req, res) => {
  const listings = await ListingModel.find({ sellerId: ownSeller(req) })
    .sort({ createdAt: -1 })
    .limit(500);
  const skus = await SkuModel.find({ _id: { $in: listings.map((l) => l.skuId) } });
  const names = await namesFor(
    skus.map((s) => s.productId),
    [],
  );
  res.json({
    listings: listings.map((l) => {
      const sku = skus.find((s) => s._id.equals(l.skuId));
      return {
        id: l.id,
        product: sku ? (names.product(sku.productId) ?? '') : '',
        pack: sku?.packLabel ?? '',
        ratePaisePerBaseUnit: l.ratePaisePerUnit,
        rateDisplay: `${formatRupees(l.ratePaisePerUnit)}/unit`,
        rateType: l.rateType,
        expiryBand: l.expiryBand,
        moqBoxes: l.moqBoxes,
        quantityBoxes: l.quantityBoxes,
        status: l.status,
        createdAt: (l as unknown as { createdAt: Date }).createdAt,
        expiresAt: l.expiresAt,
      };
    }),
  });
});

portalRouter.get('/portal/seller/confirmations', sellerOnly, async (req, res) => {
  const trades = await TradeModel.find({
    sellerId: ownSeller(req),
    sellerStage: { $exists: true },
  })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({ confirmations: await confirmationRows(trades, 'SELLER') });
});

portalRouter.get('/portal/seller/purchase-orders', sellerOnly, async (req, res) => {
  const orders = await PurchaseOrderModel.find({ sellerId: ownSeller(req) })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({
    purchaseOrders: orders.map((po) => ({
      id: po.id,
      humanNumber: po.number,
      dispatchDueDate: po.dispatchDueAt,
      hold: Boolean(po.hold), // the reason is a staff note: never shown
      goodsInAt: po.arrival?.arrivedAt ?? null,
      sellerBillAt: po.sellerBill?.at ?? null,
      // The seller's own dispatch to Indore (leg 1). The reference shows "leg 2" (our dock to the buyer) instead,
      // which is not about the seller's order.
      dispatchedAt: po.leg1?.at ?? null,
      paidAt: po.paidAt ?? null,
      createdAt: (po as unknown as { createdAt: Date }).createdAt,
      lines: po.lines.map((line) => ({
        id: `${po.id}-${line.lineNo}`,
        product: line.productName,
        pack: line.packLabel,
        boxes: line.boxes,
        sellerNetPaisePerBaseUnit: line.landedPaisePerUnit,
      })),
    })),
  });
});
