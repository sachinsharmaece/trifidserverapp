import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { Po } from '../../../models/Po.js';
import { Inspection } from '../../../models/Inspection.js';
import { PoLine } from '../../../models/PoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Listing } from '../../../models/Listing.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { SellerCatalogueEntry } from '../../../models/SellerCatalogueEntry.js';
import { Seller } from '../../../models/Seller.js';
import { AppError } from '../../../shared/errors.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import {
  getDispatchChaseQueue,
  getOpenDemandForSeller,
  getPilesAwaitingDecision,
  type DispatchQueueItem,
} from './purchase.service.js';
import {
  getBilledQueue,
  getPoQueue,
  getStockQueue,
  type PoStageItem,
  type StockQueueItem,
} from './purchase.stages.js';

/**
 * One seller's own run through the Purchase desk, as a funnel: the same stages as the desk's
 * tabs (Confirmations → Stock → PO → Billed → Dispatch), plus what he has before (carries,
 * on the board, quoted) and after (at Indore, paid). Each joint is a *current* count, and the
 * Stock, PO, Billed and Dispatch rows come from the very functions the desk tabs use, so the two
 * always agree.
 *
 * Wall (BR-067/BR-069): this is a Purchase surface — counts and goods only. No rupee figure
 * (so no rate, even on a pile) and no buyer identity.
 */

export type SellerFunnelKey =
  | 'approved'
  | 'carries'
  | 'on_board'
  | 'quoted'
  | 'confirmations'
  | 'stock'
  | 'po'
  | 'billed'
  | 'dispatch'
  | 'received'
  | 'paid';

export const SELLER_FUNNEL_LABELS: Record<SellerFunnelKey, string> = {
  approved: 'Approved',
  carries: 'Carries',
  on_board: 'On the board',
  quoted: 'Quoted',
  confirmations: 'Confirmations',
  stock: 'Hold',
  po: 'PO',
  billed: 'Billed',
  dispatch: 'Dispatch',
  received: 'At Indore',
  paid: 'Paid',
};

/** A PO released more than this long ago with no seller invoice recorded counts as a leak. */
export const PO_INVOICE_LEAK_HOURS = 24;
/** Rows shown per section; the joint's count is always the full figure. */
const ROW_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1000;

export interface SellerFunnelStage {
  key: SellerFunnelKey;
  label: string;
  reached: boolean;
  /** `null` for the yes/no joint (approved). */
  count: number | null;
  /** Stuck items at this joint — see the formula next to each in `buildStages`. */
  leakCount?: number;
}

export interface SellerQuotedRow {
  quoteId: string;
  brand: string;
  technical: string;
  packLabel: string | null;
  boxesAsked: number;
  boxesOffered: number;
  givenAt: string;
  heldUntil: string;
}

export interface SellerPileRow {
  pileId: string;
  /** What the confirm / requote / decline call is made on behalf of. */
  sellerCounterpartyId: string;
  brand: string;
  packLabel: string;
  boxes: number;
  buyers: number;
  openedAt: string;
  chaseLeftHours: number;
}

export interface SellerAfterDispatchRow {
  poId: string;
  poNo: string;
  brand: string;
  packLabel: string;
  boxes: number;
  state: string;
  receivedAt: string | null;
  updatedAt: string;
  /**
   * The dock's finding on this PO: `none` — not inspected yet (the dock's own step);
   * `recorded` — inspected, waiting for Purchase to apply it; `applied` — done.
   */
  inspection: 'none' | 'recorded' | 'applied';
}

export interface SellerFunnelDto {
  funnel: SellerFunnelStage[];
  stages: {
    quoted: SellerQuotedRow[];
    confirmations: SellerPileRow[];
    stock: Omit<StockQueueItem, 'sellerRatePaise'>[];
    po: PoStageItem[];
    billed: PoStageItem[];
    dispatch: DispatchQueueItem[];
    received: SellerAfterDispatchRow[];
    paid: SellerAfterDispatchRow[];
  };
}

const RECEIVED_PO_STATES = ['at_indore', 'inspected', 'billed', 'dispatched_leg2'] as const;

async function goodsByPo(
  pos: Array<InstanceType<typeof Po>>,
): Promise<Map<string, { brand: string; packLabel: string; boxes: number }>> {
  const lines = await PoLine.find({ poId: { $in: pos.map((p) => p._id) } });
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  return new Map(
    lines.map((line) => {
      const sku = skuById.get((line.skuId as Types.ObjectId).toString());
      const product = sku
        ? productById.get((sku.productId as Types.ObjectId).toString())
        : undefined;
      return [
        (line.poId as Types.ObjectId).toString(),
        { brand: product?.brand ?? '—', packLabel: sku?.packLabel ?? '—', boxes: line.boxes },
      ];
    }),
  );
}

async function afterDispatchRows(
  pos: Array<InstanceType<typeof Po>>,
): Promise<SellerAfterDispatchRow[]> {
  const goods = await goodsByPo(pos);
  const inspected = new Set(
    (await Inspection.find({ poId: { $in: pos.map((p) => p._id) } }, { poId: 1 })).map((i) =>
      (i.poId as Types.ObjectId).toString(),
    ),
  );
  return pos.map((po) => {
    const poId = (po._id as Types.ObjectId).toString();
    // Applying moves the PO on to `inspected` (and beyond), so the state says whether it is done.
    const applied = !['dispatched_leg1', 'at_indore'].includes(po.state);
    return {
      poId,
      poNo: po.poNo,
      ...(goods.get(poId) ?? { brand: '—', packLabel: '—', boxes: 0 }),
      state: po.state,
      receivedAt: po.receivedAt ? po.receivedAt.toISOString() : null,
      updatedAt: (po as unknown as { updatedAt: Date }).updatedAt.toISOString(),
      inspection: applied ? 'applied' : inspected.has(poId) ? 'recorded' : 'none',
    };
  });
}

async function quotedRows(sellerId: string): Promise<SellerQuotedRow[]> {
  const quotes = await Quote.find({ sellerId, status: 'live' }).sort({ bindingUntil: 1 });
  if (quotes.length === 0) return [];
  const asks = await Ask.find({ _id: { $in: quotes.map((q) => q.askId) } });
  const askById = new Map(asks.map((a) => [(a._id as Types.ObjectId).toString(), a]));
  const skus = await Sku.find({
    _id: { $in: asks.filter((a) => a.skuId).map((a) => a.skuId) },
  });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const productIds = [
    ...asks.filter((a) => a.productId).map((a) => a.productId as Types.ObjectId),
    ...skus.map((s) => s.productId as Types.ObjectId),
  ];
  const products = await Product.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));

  return quotes.map((q) => {
    const ask = askById.get((q.askId as Types.ObjectId).toString());
    const sku = ask?.skuId ? skuById.get((ask.skuId as Types.ObjectId).toString()) : undefined;
    const productId = ask?.productId ?? sku?.productId;
    const product = productId
      ? productById.get((productId as Types.ObjectId).toString())
      : undefined;
    return {
      quoteId: (q._id as Types.ObjectId).toString(),
      brand: product?.brand ?? '—',
      technical: product?.technical ?? '—',
      packLabel: sku?.packLabel ?? null,
      boxesAsked: ask?.qty ?? q.qtyAvailable,
      boxesOffered: q.qtyAvailable,
      givenAt: (q as unknown as { createdAt: Date }).createdAt.toISOString(),
      heldUntil: q.bindingUntil.toISOString(),
    };
  });
}

/** GET /staff/purchase/sellers/:sellerId/funnel */
export async function getSellerStageFunnel(sellerId: string): Promise<SellerFunnelDto> {
  assertValidObjectId(sellerId, 'sellerId');
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const now = Date.now();

  const listings = await Listing.find({ sellerId, state: 'live' }, { _id: 1 });
  const [
    carries,
    boardLines,
    quoted,
    openDemand,
    allPiles,
    stock,
    po,
    billed,
    dispatch,
    receivedPos,
    paidPos,
  ] = await Promise.all([
    SellerCatalogueEntry.countDocuments({ sellerId }),
    ListingLine.countDocuments({ listingId: { $in: listings.map((l) => l._id) }, qty: { $gt: 0 } }),
    quotedRows(sellerId),
    getOpenDemandForSeller(sellerId),
    getPilesAwaitingDecision(),
    getStockQueue(sellerId),
    getPoQueue(sellerId),
    getBilledQueue(sellerId),
    getDispatchChaseQueue(sellerId),
    Po.find({
      sellerId,
      failed: false,
      paid: false,
      $or: [
        { state: { $in: [...RECEIVED_PO_STATES] } },
        { state: 'dispatched_leg1', receivedAt: { $ne: null } },
      ],
    }).sort({ updatedAt: -1 }),
    Po.find({ sellerId, failed: false, paid: true }).sort({ updatedAt: -1 }),
  ]);

  const piles: SellerPileRow[] = allPiles
    .filter((p) => p.sellerId === sellerId)
    // The rate is a rupee figure: left out on purpose, this is a Purchase surface.
    .map((p) => ({
      pileId: p.pileId,
      sellerCounterpartyId: p.sellerCounterpartyId,
      brand: p.brand,
      packLabel: p.packLabel,
      boxes: p.boxes,
      buyers: p.buyers,
      openedAt: p.openedAt,
      chaseLeftHours: p.chaseLeftHours,
    }));

  const stage = (
    key: SellerFunnelKey,
    count: number | null,
    extra: Partial<SellerFunnelStage> = {},
  ): SellerFunnelStage => ({
    key,
    label: SELLER_FUNNEL_LABELS[key],
    reached: count === null ? true : count > 0,
    count,
    ...extra,
  });

  const funnel: SellerFunnelStage[] = [
    stage('approved', null),
    stage('carries', carries),
    stage('on_board', boardLines),
    stage('quoted', quoted.length, {
      // Asks on a product he carries that he has not quoted yet.
      leakCount: openDemand.filter((d) => !d.hasQuoted).length,
    }),
    stage('confirmations', piles.length, {
      leakCount: piles.filter((p) => p.chaseLeftHours < 0).length,
    }),
    stage('stock', stock.length, {
      leakCount: stock.filter((s) => s.hold === 'lapsed').length,
    }),
    stage('po', po.length, {
      leakCount: po.filter(
        (p) => now - new Date(p.releasedAt).getTime() > PO_INVOICE_LEAK_HOURS * HOUR_MS,
      ).length,
    }),
    stage('billed', billed.length),
    stage('dispatch', dispatch.length, {
      leakCount: dispatch.filter((d) => d.sameDayMiss || d.noDispatch48h).length,
    }),
    stage('received', receivedPos.length),
    stage('paid', paidPos.length),
  ];

  return {
    funnel,
    stages: {
      quoted: quoted.slice(0, ROW_LIMIT),
      confirmations: piles.slice(0, ROW_LIMIT),
      // This view carries counts and goods only — the rate stays on the Stock tab.
      stock: stock.slice(0, ROW_LIMIT).map((item) => {
        const row: Partial<StockQueueItem> = { ...item };
        delete row.sellerRatePaise;
        return row as Omit<StockQueueItem, 'sellerRatePaise'>;
      }),
      po: po.slice(0, ROW_LIMIT),
      billed: billed.slice(0, ROW_LIMIT),
      dispatch: dispatch.slice(0, ROW_LIMIT),
      received: await afterDispatchRows(receivedPos.slice(0, ROW_LIMIT)),
      paid: await afterDispatchRows(paidPos.slice(0, ROW_LIMIT)),
    },
  };
}
