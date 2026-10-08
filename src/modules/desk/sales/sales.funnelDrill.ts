import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Product } from '../../../models/Product.js';
import { Quote } from '../../../models/Quote.js';
import { Sku } from '../../../models/Sku.js';
import { addDays } from '../../../shared/clock.js';

/**
 * The records behind the Sales funnel's "Asked" and "Rate held" counts — the
 * same filters `sales.funnel.ts` counts with, listed instead of counted, so
 * the number on the Funnel and the rows behind it can never disagree.
 */

// Kept in step with `ASK_LEAK_STALENESS_HOURS` in sales.funnel.ts (not exported there).
const ASK_LEAK_STALENESS_HOURS = 26;

interface AskLike {
  buyerId: unknown;
  productId?: unknown;
  skuId?: unknown;
}

export interface FunnelAskRow {
  askId: string;
  buyerId: string;
  buyerFirm: string;
  productId: string | null;
  brand: string;
  technical: string;
  packLabel: string | null;
  qty: number;
  state: string;
  createdAt: string;
  pastSla: boolean; // Still "open" (no quote at all) after the staleness window — the funnel's leak.
}

export interface FunnelHeldRateRow {
  quoteId: string;
  askId: string;
  buyerId: string;
  buyerFirm: string;
  productId: string | null;
  brand: string;
  technical: string;
  packLabel: string | null;
  qty: number;
  heldUntil: string;
}

/** Product, pack and buyer-firm names for a batch of asks, resolved in a few queries. */
async function describeAsks(asks: AskLike[]) {
  const skuIds = asks.filter((a) => a.skuId).map((a) => a.skuId as Types.ObjectId);
  const skus = skuIds.length ? await Sku.find({ _id: { $in: skuIds } }) : [];
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const productIdOf = (a: AskLike): string | null =>
    a.productId
      ? (a.productId as Types.ObjectId).toString()
      : a.skuId
        ? ((
            skuById.get((a.skuId as Types.ObjectId).toString())?.productId as
              Types.ObjectId | undefined
          )?.toString() ?? null)
        : null;

  const productIds = [...new Set(asks.map(productIdOf).filter((id): id is string => !!id))];
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }) : [];
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));

  const buyers = await Buyer.find({ _id: { $in: asks.map((a) => a.buyerId) } });
  const counterparties = buyers.length
    ? await Counterparty.find({ _id: { $in: buyers.map((b) => b.counterpartyId) } })
    : [];
  const firmByCounterpartyId = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '']),
  );
  const firmByBuyerId = new Map(
    buyers.map((b) => [
      (b._id as Types.ObjectId).toString(),
      firmByCounterpartyId.get((b.counterpartyId as Types.ObjectId).toString()) ?? '',
    ]),
  );

  return (a: AskLike) => {
    const productId = productIdOf(a);
    const product = productId ? productById.get(productId) : undefined;
    const sku = a.skuId ? skuById.get((a.skuId as Types.ObjectId).toString()) : undefined;
    const buyerId = (a.buyerId as Types.ObjectId).toString();
    return {
      buyerId,
      buyerFirm: firmByBuyerId.get(buyerId) ?? '',
      productId,
      brand: product?.brand ?? '—',
      technical: product?.technical ?? '—',
      packLabel: sku?.packLabel ?? null,
    };
  };
}

/** GET /staff/sales/funnel/asked — the asks counted under "Asked", oldest first. */
export async function listFunnelAsks(now: Date = new Date()): Promise<FunnelAskRow[]> {
  const asks = await Ask.find({ state: { $nin: ['lapsed', 'withdrawn'] } }).sort({ createdAt: 1 });
  const describe = await describeAsks(asks);
  const staleBefore = addDays(now, -(ASK_LEAK_STALENESS_HOURS / 24));
  return asks.map((a) => {
    const createdAt = (a as unknown as { createdAt: Date }).createdAt;
    return {
      askId: (a._id as Types.ObjectId).toString(),
      ...describe(a),
      qty: a.qty,
      state: a.state,
      createdAt: createdAt.toISOString(),
      pastSla: a.state === 'open' && createdAt <= staleBefore,
    };
  });
}

/** GET /staff/sales/funnel/rate-held — the live quotes counted under "Rate held", soonest to lapse first. */
export async function listFunnelHeldRates(): Promise<FunnelHeldRateRow[]> {
  const quotes = await Quote.find({ status: 'live' }).sort({ bindingUntil: 1 });
  const asks = quotes.length ? await Ask.find({ _id: { $in: quotes.map((q) => q.askId) } }) : [];
  const askById = new Map(asks.map((a) => [(a._id as Types.ObjectId).toString(), a]));
  const describe = await describeAsks(asks);

  const rows: FunnelHeldRateRow[] = [];
  for (const q of quotes) {
    const ask = askById.get((q.askId as Types.ObjectId).toString());
    if (!ask) continue; // A live quote whose ask is gone has no buyer to show.
    rows.push({
      quoteId: (q._id as Types.ObjectId).toString(),
      askId: (ask._id as Types.ObjectId).toString(),
      ...describe(ask),
      qty: ask.qty,
      heldUntil: q.bindingUntil.toISOString(),
    });
  }
  return rows;
}
