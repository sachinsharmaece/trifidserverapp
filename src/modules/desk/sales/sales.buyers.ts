import type { Types } from 'mongoose';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Tehsil } from '../../../models/Tehsil.js';
import { BookAssignment } from '../../../models/BookAssignment.js';
import { Employee } from '../../../models/Employee.js';
import { So } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { Pool } from '../../../models/Pool.js';
import { PoolCommitment } from '../../../models/PoolCommitment.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { AppError } from '../../../shared/errors.js';
import { computeBuyerFacingRatePaise } from '../../listing/listing.service.js';
import { addDays } from '../../../shared/clock.js';
import {
  ASK_LEAK_STALENESS_HOURS,
  BILLED_SO_STATES,
  DELIVERED_SO_STATES,
  DISPATCHED_SO_STATES,
  FUNNEL_LABELS,
  PAID_SO_STATES,
  PAYMENT_PENDING_SO_STATES,
  type FunnelKey,
} from './sales.funnel.js';
import { listCallLogsForBuyer, type CallLogDto } from './sales.calls.js';
import { listOrders, type SalesOrderRow } from './sales.orders.js';

// B-52 — `tradePosition` is stored lowercase (the enum); `rateTier` (the
// pricing-side computation in chain.service.ts#toRateTier) already
// capitalizes it for that reason, but this desk re-derives the same "tier"
// label inline without doing so, showing e.g. "retailer" next to "Trader".
// Not reusing `toRateTier` outright: it defaults an unclassified buyer to
// Retailer for pricing (BR-044), but this screen means to show blank for
// "not yet classified" — a real, separate signal for staff, not lost here.
function capitalizeTradePosition(tradePosition: string): string {
  return tradePosition.charAt(0).toUpperCase() + tradePosition.slice(1);
}

// Phase 3 (DEC-058) — the category, or for a buyer not yet migrated the old
// position/trader flag; blank when he was never classified.
function categoryOf(buyer: {
  category?: string | null;
  isTrader: boolean;
  tradePosition?: string | null;
}): string | null {
  if (buyer.category) return buyer.category;
  if (buyer.isTrader) return 'Trader';
  return buyer.tradePosition ? capitalizeTradePosition(buyer.tradePosition) : null;
}

export interface BuyerListRow {
  buyerId: string;
  firm: string;
  gstin: string | null;
  /** Phase 3 — shown as "Unregistered · PAN" when there is no GSTIN. */
  pan: string | null;
  tehsil: string | null;
  district: string | null;
  /** The category (Retailer / Dealer / Distributor / Trader). */
  tier: string | null;
  /** The Sales person he is assigned to; null = the Queue. */
  assignedToEmployeeId: string | null;
  orderCount: number;
  lastOrderAt: string | null;
  rateViews: number;
  ownerName: string | null; // The Sales employee whose book he is in — not the firm's owner.
  contactName: string | null; // The firm's own owner, from the counterparty.
  mobile: string | null;
}

/**
 * GET /staff/sales/buyers?q=&tab=book|queue&category=&districtId=&assignedTo=
 * Phase 3 — filters by category, district and Assigned to (an employee id,
 * or `queue`).
 */
export interface BuyerListFacets {
  districts: Array<{ districtId: string; name: string }>;
  assignees: Array<{ employeeId: string; person: string }>;
}

/** Everything, as before (the top-bar search uses this). */
export async function listBuyers(filters: BuyerListFilters): Promise<BuyerListRow[]> {
  return (await listBuyersPage(filters)).items;
}

export interface BuyerListFilters {
  q?: string;
  tab?: 'book' | 'queue';
  category?: string;
  districtId?: string;
  assignedTo?: string;
  /** 29 Oct — default `firm` (A→Z); `dir` default `asc`. */
  sort?: BuyerListSort;
  dir?: 'asc' | 'desc';
}

export const BUYER_LIST_SORTS = [
  'firm',
  'tehsil',
  'district',
  'registered',
  'orders',
  'lastOrder',
  'rateViews',
] as const;
export type BuyerListSort = (typeof BUYER_LIST_SORTS)[number];

/**
 * 29 Oct — one page of the Buyers list (`offset`/`limit`), with the total and
 * the filter options for the whole tab (every district and assignee in it,
 * not only those on this page). Without `limit`, the whole list.
 */
export async function listBuyersPage(
  filters: BuyerListFilters,
  page: { offset?: number; limit?: number } = {},
): Promise<{ items: BuyerListRow[]; total: number; facets: BuyerListFacets }> {
  const assignments = await BookAssignment.find({});
  const ownerEmployeeIdByBuyer = new Map(
    assignments.map((a) => [(a.buyerId as Types.ObjectId).toString(), a.ownerEmployeeId]),
  );

  const buyerQuery: Record<string, unknown> = {};
  if (filters.category) buyerQuery.category = filters.category;
  if (filters.districtId) {
    const inDistrict = await Tehsil.find({ districtId: filters.districtId }, { _id: 1 });
    buyerQuery.tehsilId = { $in: inDistrict.map((t) => t._id) };
  }
  let buyers = await Buyer.find(buyerQuery).sort({ createdAt: -1 });
  if (filters.assignedTo === 'queue') {
    buyers = buyers.filter(
      (b) => !ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString()),
    );
  } else if (filters.assignedTo) {
    buyers = buyers.filter(
      (b) =>
        ownerEmployeeIdByBuyer.get((b._id as Types.ObjectId).toString())?.toString() ===
        filters.assignedTo,
    );
  }
  if (filters.tab === 'book') {
    buyers = buyers.filter((b) => ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString()));
  } else if (filters.tab === 'queue') {
    buyers = buyers.filter(
      (b) => !ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString()),
    );
  }
  const facets = await facetsFor(filters.tab, ownerEmployeeIdByBuyer);

  const counterparties = await Counterparty.find({
    _id: { $in: buyers.map((b) => b.counterpartyId) },
  });
  const counterpartyById = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c]),
  );

  if (filters.q) {
    const q = filters.q.toLowerCase();
    const matchingTehsils = await Tehsil.find({ name: { $regex: filters.q, $options: 'i' } });
    const matchingTehsilIds = new Set(
      matchingTehsils.map((t) => (t._id as Types.ObjectId).toString()),
    );
    buyers = buyers.filter((b) => {
      const cp = counterpartyById.get((b.counterpartyId as Types.ObjectId).toString());
      const inTehsil =
        Boolean(b.tehsilId) && matchingTehsilIds.has((b.tehsilId as Types.ObjectId).toString());
      return Boolean(
        cp?.firm?.toLowerCase().includes(q) ||
        cp?.gstin?.toLowerCase().includes(q) ||
        cp?.pan?.toLowerCase().includes(q) ||
        cp?.ownerName?.toLowerCase().includes(q) ||
        cp?.mobile?.toLowerCase().includes(q) ||
        cp?.contactMobile?.toLowerCase().includes(q) ||
        inTehsil,
      );
    });
  }

  // 29 Oct — names and order stats for the whole filtered list, not just the page, so the list
  // can be sorted by any column before it is cut into pages.
  const tehsilIds = [
    ...new Set(
      buyers.filter((b) => b.tehsilId).map((b) => (b.tehsilId as Types.ObjectId).toString()),
    ),
  ];
  const tehsils = await Tehsil.find({ _id: { $in: tehsilIds } });
  const tehsilNameById = new Map(
    tehsils.map((t) => [(t._id as Types.ObjectId).toString(), t.name]),
  );
  const districtByTehsilId = new Map(
    tehsils.map((t) => [(t._id as Types.ObjectId).toString(), t.district]),
  );

  const statRows = buyers.length
    ? await So.aggregate<{ _id: Types.ObjectId; count: number; lastOrderAt: Date }>([
        { $match: { buyerId: { $in: buyers.map((b) => b._id) } } },
        { $group: { _id: '$buyerId', count: { $sum: 1 }, lastOrderAt: { $max: '$createdAt' } } },
      ])
    : [];
  const orderStatsByBuyer = new Map(
    statRows.map((r) => [r._id.toString(), { count: r.count, lastOrderAt: r.lastOrderAt }]),
  );

  const tehsilKey = (b: (typeof buyers)[number]) =>
    b.tehsilId ? (tehsilNameById.get((b.tehsilId as Types.ObjectId).toString()) ?? null) : null;
  const districtKey = (b: (typeof buyers)[number]) =>
    b.tehsilId ? (districtByTehsilId.get((b.tehsilId as Types.ObjectId).toString()) ?? null) : null;
  const firmKey = (b: (typeof buyers)[number]) =>
    counterpartyById.get((b.counterpartyId as Types.ObjectId).toString())?.firm?.trim() || null;
  const sortKey = (b: (typeof buyers)[number]): string | number | null => {
    const stats = orderStatsByBuyer.get((b._id as Types.ObjectId).toString());
    switch (filters.sort ?? 'firm') {
      case 'tehsil':
        return tehsilKey(b);
      case 'district':
        return districtKey(b);
      case 'registered':
        return (b as unknown as { createdAt: Date }).createdAt.getTime();
      case 'orders':
        return stats?.count ?? null;
      case 'lastOrder':
        return stats?.lastOrderAt ? stats.lastOrderAt.getTime() : null;
      case 'rateViews':
        return b.rateViews ?? 0;
      default:
        return firmKey(b);
    }
  };
  buyers = sortBuyers(buyers, sortKey, firmKey, filters.dir ?? 'asc');

  const total = buyers.length;
  if (page.limit) {
    const offset = page.offset ?? 0;
    buyers = buyers.slice(offset, offset + page.limit);
  }

  const employees = await Employee.find({ _id: { $in: [...ownerEmployeeIdByBuyer.values()] } });
  const employeeNameById = new Map(
    employees.map((e) => [(e._id as Types.ObjectId).toString(), e.person]),
  );

  const items: BuyerListRow[] = buyers.map((b) => {
    const idStr = (b._id as Types.ObjectId).toString();
    const cp = counterpartyById.get((b.counterpartyId as Types.ObjectId).toString());
    const ownerEmployeeId = ownerEmployeeIdByBuyer.get(idStr);
    const stats = orderStatsByBuyer.get(idStr);
    return {
      buyerId: idStr,
      firm: cp?.firm ?? '',
      gstin: cp?.gstin ?? null,
      pan: cp?.pan ?? null,
      contactName: cp?.ownerName ?? null,
      mobile: cp?.contactMobile ?? cp?.mobile ?? null,
      tehsil: b.tehsilId
        ? (tehsilNameById.get((b.tehsilId as Types.ObjectId).toString()) ?? null)
        : null,
      district: b.tehsilId
        ? (districtByTehsilId.get((b.tehsilId as Types.ObjectId).toString()) ?? null)
        : null,
      tier: categoryOf(b),
      assignedToEmployeeId: ownerEmployeeId ? ownerEmployeeId.toString() : null,
      orderCount: stats?.count ?? 0,
      lastOrderAt: stats?.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
      rateViews: b.rateViews,
      ownerName: ownerEmployeeId
        ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null)
        : null,
    };
  });
  return { items, total, facets };
}

const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Sorts by `key` in `dir`; a buyer with no value (no firm, no tehsil, never ordered) goes last
 * either way. Ties fall back to firm A→Z, then id, so pages never repeat or skip a row.
 */
function sortBuyers<B extends { _id: unknown }>(
  buyers: B[],
  key: (b: B) => string | number | null,
  firmKey: (b: B) => string | null,
  dir: 'asc' | 'desc',
): B[] {
  const sign = dir === 'desc' ? -1 : 1;
  const compareValues = (a: string | number, b: string | number) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : byName.compare(String(a), String(b));
  return buyers
    .map((b) => ({ b, k: key(b), f: firmKey(b), id: String(b._id) }))
    .sort((x, y) => {
      if (x.k === null && y.k !== null) return 1;
      if (y.k === null && x.k !== null) return -1;
      if (x.k !== null && y.k !== null) {
        const c = compareValues(x.k, y.k);
        if (c !== 0) return sign * c;
      }
      if (x.f !== y.f) {
        if (x.f === null) return 1;
        if (y.f === null) return -1;
        const c = byName.compare(x.f, y.f);
        if (c !== 0) return c;
      }
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    })
    .map((r) => r.b);
}

export interface BuyerProductHistoryRow {
  productId: string;
  brand: string;
  orderCount: number;
  // BR-045 — the five frozen values on an order line are never re-derived,
  // so the latest order's own `ratePaise` is exactly "what he last paid",
  // not a current-rate lookup.
  lastPaidRatePaise: number | null;
}

export interface BuyerFileOpenAsk {
  askId: string;
  productId: string | null;
  skuId: string | null;
  qty: number;
  state: string;
  brand: string;
  technical: string;
  packLabel: string | null; // Only when the ask names a specific pack.
  askedAt: string;
  /** What he said he hopes to pay, noted on the call — Sales-internal. */
  expectedRatePaise: number | null;
  /** Quotes already raised on this ask that Sales has not yet given him. */
  pendingQuotes: BuyerFileParkedQuote[];
}

/**
 * A quote raised on his ask (by the seller, or by Purchase on his behalf) and waiting for Sales
 * to give it to him. It is already a listing line for every buyer.
 */
export interface BuyerFileParkedQuote {
  quoteId: string;
  askId: string;
  /** The listing line this quote was published as — the same offer shows on his board. */
  listingLineId: string | null;
  packLabel: string | null;
  /** His own rate — seller net plus the margin-matrix cell for his tier. `null`: no cell yet. */
  ratePaise: number | null;
  qtyAvailable: number;
  daysToIndore: number;
  expiryBand: string;
  expiryExact: string;
  deliveryBand: string;
  raisedAt: string;
}

/** A live quote on one of his asks — the rate he is holding right now. */
export interface BuyerFileLiveQuote {
  quoteId: string;
  askId: string;
  productId: string | null;
  brand: string;
  packLabel: string | null;
  /** His own rate — seller net plus the margin-matrix cell for his tier; what he is shown. */
  ratePaise: number | null;
  qtyAvailable: number;
  /** How many boxes he asked for — what Confirm compares the quote against. */
  askQty: number;
  daysToIndore: number;
  /** When the rate was given to him; the desk shows it as "15 minutes ago". */
  givenAt: string;
  bindingUntil: string;
}

/**
 * 29 Oct — a listed offer he has been put on (by Sales on a call, or by his own Buy button) that
 * is waiting on the seller: a pile request (Purchase → Confirmations) or a place in a pool that
 * has not reached its minimum yet. Once the seller confirms it is an order and shows there.
 */
export interface BuyerFileWaitingOnSeller {
  kind: 'pile' | 'pool';
  /** The pile request, or the pool commitment. */
  id: string;
  productId: string | null;
  brand: string;
  packLabel: string | null;
  qty: number;
  /** His own rate on the offer — pile only; a pool's rate is set when it triggers. */
  ratePaise: number | null;
  requestedAt: string;
  /** Pile only — when the seller's window to confirm ends. */
  decideBy: string | null;
  /** Pool only — boxes in so far, against its minimum. */
  pool: { committedBoxes: number; moq: number; status: string } | null;
}

/** His orders sliced by the funnel joint they sit at; `other` is every state outside the three. */
export interface BuyerFileOrdersByStage {
  paymentPending: SalesOrderRow[];
  paid: SalesOrderRow[];
  billed: SalesOrderRow[];
  dispatched: SalesOrderRow[];
  delivered: SalesOrderRow[];
  other: SalesOrderRow[];
}

/** One joint of the Sales funnel, read for this one buyer. */
export interface BuyerFunnelStage {
  key: FunnelKey;
  label: string;
  reached: boolean;
  /** His own count at this joint; `null` for the yes/no joints (registered, classified, ordered again). */
  count: number | null;
  /** Only on `asked` — his asks still "open" (no quote at all) past the funnel's staleness limit. */
  leakCount?: number;
}

export interface BuyerFileDto {
  buyerId: string;
  counterpartyId: string;
  firm: string;
  gstin: string | null;
  mobile: string;
  tehsil: string | null;
  tier: string | null;
  classified: boolean;
  rateViews: number;
  ownerName: string | null;
  funnel: BuyerFunnelStage[];
  productHistory: BuyerProductHistoryRow[];
  openAsks: BuyerFileOpenAsk[];
  waitingOnSeller: BuyerFileWaitingOnSeller[];
  liveQuotes: BuyerFileLiveQuote[];
  callLogs: CallLogDto[];
  orders: SalesOrderRow[];
  ordersByStage: BuyerFileOrdersByStage;
}

/** GET /staff/sales/buyers/:buyerId — the buyer-file drill-down. */
export async function getBuyerFile(buyerId: string): Promise<BuyerFileDto> {
  const buyer = await Buyer.findById(buyerId);
  if (!buyer) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
  const counterparty = await Counterparty.findById(buyer.counterpartyId);
  const tehsil = buyer.tehsilId ? await Tehsil.findById(buyer.tehsilId) : null;
  const assignment = await BookAssignment.findOne({ buyerId: buyer._id });
  const owner = assignment ? await Employee.findById(assignment.ownerEmployeeId) : null;

  const sos = await So.find({ buyerId: buyer._id });
  const lines = await SoLine.find({ soId: { $in: sos.map((s) => s._id) } });
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  const soById = new Map(sos.map((s) => [(s._id as Types.ObjectId).toString(), s]));

  const orderCountByProduct = new Map<string, number>();
  const lastPaidByProduct = new Map<string, { ratePaise: number; at: Date }>();
  for (const line of lines) {
    const sku = skuById.get((line.skuId as Types.ObjectId).toString());
    if (!sku) continue;
    const productId = (sku.productId as Types.ObjectId).toString();
    orderCountByProduct.set(productId, (orderCountByProduct.get(productId) ?? 0) + 1);

    const so = soById.get((line.soId as Types.ObjectId).toString());
    const at = so ? (so as unknown as { createdAt: Date }).createdAt : null;
    if (at) {
      const current = lastPaidByProduct.get(productId);
      if (!current || at > current.at) {
        lastPaidByProduct.set(productId, { ratePaise: line.ratePaise, at });
      }
    }
  }
  const productHistory: BuyerProductHistoryRow[] = [...orderCountByProduct.entries()].map(
    ([productId, orderCount]) => ({
      productId,
      brand: productById.get(productId)?.brand ?? '',
      orderCount,
      lastPaidRatePaise: lastPaidByProduct.get(productId)?.ratePaise ?? null,
    }),
  );

  // An ask moves on as it is worked: `open` (waiting on a rate) is "He asked"; once a rate is
  // given it is `quoted` and lives under "Rate given"; once he confirms it is an order.
  const liveAsks = await Ask.find({
    buyerId: buyer._id,
    state: { $in: ['open', 'quoted'] },
  }).sort({
    createdAt: -1,
  });
  // Quotes raised on his asks that Sales has not yet given him — the ask is still "He asked" for
  // those, even once another quote has been given and it also shows under "Rate given".
  const parkedQuotes = liveAsks.length
    ? await Quote.find({
        askId: { $in: liveAsks.map((a) => a._id) },
        status: 'pending_sales',
      }).sort({ createdAt: 1 })
    : [];
  const parkedByAskId = new Map<string, typeof parkedQuotes>();
  for (const quote of parkedQuotes) {
    const key = (quote.askId as Types.ObjectId).toString();
    parkedByAskId.set(key, [...(parkedByAskId.get(key) ?? []), quote]);
  }
  // "He asked" is an ask still waiting on a rate. The moment any rate is given it moves to
  // "Rate given"; quotes parked on it show on its row for as long as it is waiting.
  const openAsks = liveAsks.filter((a) => a.state === 'open');

  // An ask names a product, or only a pack (SKU) — resolve either to the product so
  // "He asked" can show a name, never a bare id.
  const askSkus = await Sku.find({
    _id: { $in: liveAsks.filter((a) => a.skuId).map((a) => a.skuId) },
  });
  const askSkuById = new Map(askSkus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const askProductIdOf = (a: (typeof liveAsks)[number]): string | null =>
    a.productId
      ? (a.productId as Types.ObjectId).toString()
      : a.skuId
        ? ((
            askSkuById.get((a.skuId as Types.ObjectId).toString())?.productId as
              Types.ObjectId | undefined
          )?.toString() ?? null)
        : null;
  const askProducts = await Product.find({
    _id: { $in: [...new Set(liveAsks.map(askProductIdOf).filter((id): id is string => !!id))] },
  });
  const askProductById = new Map(askProducts.map((p) => [(p._id as Types.ObjectId).toString(), p]));

  const [callLogs, orders, liveQuotes] = await Promise.all([
    listCallLogsForBuyer(buyerId),
    listOrders({ buyerId }),
    Quote.find({ askId: { $in: liveAsks.map((a) => a._id) }, status: 'live' }).sort({
      bindingUntil: 1,
    }),
  ]);
  const liveQuoteCount = liveQuotes.length;
  const askById = new Map(liveAsks.map((a) => [(a._id as Types.ObjectId).toString(), a]));

  // The pack a quote names (a product-level ask has none of its own), and his rate on it: the
  // seller's net plus the margin-matrix cell for his tier — the same figure he is shown.
  const quoteSkuIds = [...liveQuotes, ...parkedQuotes]
    .map((q) => q.skuId)
    .filter((id): id is NonNullable<typeof id> => !!id);
  const quoteSkus = quoteSkuIds.length ? await Sku.find({ _id: { $in: quoteSkuIds } }) : [];
  const quoteSkuById = new Map(quoteSkus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const skuOfQuote = (q: (typeof liveQuotes)[number]) => {
    const ask = askById.get((q.askId as Types.ObjectId).toString());
    const skuId = q.skuId ?? ask?.skuId;
    return skuId
      ? (quoteSkuById.get(skuId.toString()) ?? askSkuById.get(skuId.toString()))
      : undefined;
  };
  const buyerRateOf = async (q: (typeof liveQuotes)[number]): Promise<number | null> => {
    const ask = askById.get((q.askId as Types.ObjectId).toString());
    const skuId = q.skuId ?? ask?.skuId;
    return skuId ? computeBuyerFacingRatePaise(buyer, skuId, q.ratePaiseForIndore) : null;
  };

  const liveQuoteRows: BuyerFileLiveQuote[] = await Promise.all(
    liveQuotes.map(async (q) => {
      const ask = askById.get((q.askId as Types.ObjectId).toString());
      const productId = ask ? askProductIdOf(ask) : null;
      return {
        quoteId: (q._id as Types.ObjectId).toString(),
        askId: (q.askId as Types.ObjectId).toString(),
        productId,
        brand: (productId ? askProductById.get(productId)?.brand : undefined) ?? '—',
        packLabel: skuOfQuote(q)?.packLabel ?? null,
        ratePaise: await buyerRateOf(q),
        qtyAvailable: q.qtyAvailable,
        askQty: ask?.qty ?? q.qtyAvailable,
        daysToIndore: q.daysToIndore,
        givenAt: (q as unknown as { createdAt: Date }).createdAt.toISOString(),
        bindingUntil: q.bindingUntil.toISOString(),
      };
    }),
  );
  const parkedRowsByAskId = new Map<string, BuyerFileParkedQuote[]>();
  for (const q of parkedQuotes) {
    const row: BuyerFileParkedQuote = {
      quoteId: (q._id as Types.ObjectId).toString(),
      askId: (q.askId as Types.ObjectId).toString(),
      listingLineId: q.listingLineId ? (q.listingLineId as Types.ObjectId).toString() : null,
      packLabel: skuOfQuote(q)?.packLabel ?? null,
      ratePaise: await buyerRateOf(q),
      qtyAvailable: q.qtyAvailable,
      daysToIndore: q.daysToIndore,
      expiryBand: q.conditionSet?.expiryBand ?? '',
      expiryExact: q.conditionSet?.expiryExact ?? '',
      deliveryBand: q.conditionSet?.deliveryBand ?? '',
      raisedAt: (q as unknown as { createdAt: Date }).createdAt.toISOString(),
    };
    parkedRowsByAskId.set(row.askId, [...(parkedRowsByAskId.get(row.askId) ?? []), row]);
  }

  const waitingOnSeller = await listWaitingOnSeller(buyer);

  // The same nine joints as the Funnel tab, with the same state lists and wording,
  // counted over this buyer's own records only.
  const staleBefore = addDays(new Date(), -(ASK_LEAK_STALENESS_HOURS / 24));
  // An ask with a quote already waiting on Sales is not stale — the wait is on this desk.
  const askLeakCount = openAsks.filter(
    (a) =>
      a.state === 'open' &&
      !parkedByAskId.has((a._id as Types.ObjectId).toString()) &&
      (a as unknown as { createdAt: Date }).createdAt <= staleBefore,
  ).length;
  const countOrders = (states: readonly string[]): number =>
    orders.filter((o) => states.includes(o.state)).length;
  const pendingCount = countOrders(PAYMENT_PENDING_SO_STATES);
  const paidCount = countOrders(PAID_SO_STATES);
  const billedCount = countOrders(BILLED_SO_STATES);
  const dispatchedCount = countOrders(DISPATCHED_SO_STATES);
  const deliveredCount = countOrders(DELIVERED_SO_STATES);
  // Same state lists as the three counts above, so each section's size is its joint's count.
  const inStates = (states: readonly string[]): SalesOrderRow[] =>
    orders.filter((o) => states.includes(o.state));
  const ordersByStage: BuyerFileOrdersByStage = {
    paymentPending: inStates(PAYMENT_PENDING_SO_STATES),
    paid: inStates(PAID_SO_STATES),
    billed: inStates(BILLED_SO_STATES),
    dispatched: inStates(DISPATCHED_SO_STATES),
    delivered: inStates(DELIVERED_SO_STATES),
    other: orders.filter(
      (o) =>
        ![
          ...PAYMENT_PENDING_SO_STATES,
          ...PAID_SO_STATES,
          ...BILLED_SO_STATES,
          ...DISPATCHED_SO_STATES,
          ...DELIVERED_SO_STATES,
        ].includes(o.state as never),
    ),
  };
  const stage = (
    key: FunnelKey,
    reached: boolean,
    count: number | null,
    extra: Partial<BuyerFunnelStage> = {},
  ): BuyerFunnelStage => ({ key, label: FUNNEL_LABELS[key], reached, count, ...extra });
  const funnel: BuyerFunnelStage[] = [
    stage('registered', true, null), // This desk only lists buyers who are already approved.
    stage('classified', buyer.classified, null),
    stage('viewing', buyer.rateViews > 0, buyer.rateViews),
    stage('asked', openAsks.length > 0, openAsks.length, { leakCount: askLeakCount }),
    stage('rate_held', liveQuoteCount > 0, liveQuoteCount),
    stage('took_it', pendingCount > 0, pendingCount),
    stage('paid', paidCount > 0, paidCount),
    stage('billed', billedCount > 0, billedCount),
    stage('dispatched', dispatchedCount > 0, dispatchedCount),
    stage('delivered', deliveredCount > 0, deliveredCount),
    stage('ordered_again', sos.length > 1, null),
  ];

  return {
    buyerId: (buyer._id as Types.ObjectId).toString(),
    // BR-088-adjacent — `buyerId` here is the Buyer document, not the
    // Counterparty; the proxy endpoints (`requireActiveBuyer`) key on
    // `Buyer.counterpartyId`, so callers that hand this DTO's id straight to
    // a proxy action get a guaranteed "Buyers only." — this is the correct
    // id for that (same field EnterListingPage.tsx already uses on the
    // seller side).
    counterpartyId: (buyer.counterpartyId as Types.ObjectId).toString(),
    firm: counterparty?.firm ?? '',
    gstin: counterparty?.gstin ?? null,
    mobile: counterparty?.contactMobile ?? counterparty?.mobile ?? '',
    tehsil: tehsil?.name ?? null,
    tier: categoryOf(buyer),
    classified: buyer.classified,
    rateViews: buyer.rateViews,
    ownerName: owner?.person ?? null,
    funnel,
    productHistory,
    openAsks: openAsks.map((a) => {
      const productId = askProductIdOf(a);
      const product = productId ? askProductById.get(productId) : undefined;
      const sku = a.skuId ? askSkuById.get((a.skuId as Types.ObjectId).toString()) : undefined;
      return {
        askId: (a._id as Types.ObjectId).toString(),
        productId,
        skuId: a.skuId ? (a.skuId as Types.ObjectId).toString() : null,
        qty: a.qty,
        state: a.state,
        brand: product?.brand ?? '—',
        technical: product?.technical ?? '—',
        packLabel: sku?.packLabel ?? null,
        askedAt: (a as unknown as { createdAt: Date }).createdAt.toISOString(),
        expectedRatePaise: a.expectedRatePaise ?? null,
        pendingQuotes: parkedRowsByAskId.get((a._id as Types.ObjectId).toString()) ?? [],
      };
    }),
    waitingOnSeller,
    liveQuotes: liveQuoteRows,
    callLogs,
    orders,
    ordersByStage,
  };
}

/**
 * The filter options for a tab, over every buyer in it — districts by id and
 * name, and the people buyers are assigned to — so a filter can pick a value
 * that is not on the page loaded so far.
 */
async function facetsFor(
  tab: 'book' | 'queue' | undefined,
  ownerEmployeeIdByBuyer: Map<string, unknown>,
): Promise<BuyerListFacets> {
  const inTab = (await Buyer.find({}, { tehsilId: 1 })).filter((b) => {
    const owned = ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString());
    return tab === 'book' ? owned : tab === 'queue' ? !owned : true;
  });
  const tehsils = await Tehsil.find(
    { _id: { $in: inTab.map((b) => b.tehsilId).filter(Boolean) }, districtId: { $ne: null } },
    { districtId: 1, district: 1 },
  );
  const districts = new Map<string, string>();
  for (const t of tehsils) districts.set(String(t.districtId), t.district ?? '');
  const ownerIds =
    tab === 'queue'
      ? []
      : [
          ...new Set(
            inTab
              .map((b) => ownerEmployeeIdByBuyer.get((b._id as Types.ObjectId).toString()))
              .filter(Boolean)
              .map(String),
          ),
        ];
  const people = await Employee.find({ _id: { $in: ownerIds } }, { person: 1 });
  return {
    districts: [...districts]
      .map(([districtId, name]) => ({ districtId, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    assignees: people
      .map((e) => ({ employeeId: String(e._id), person: e.person }))
      .sort((a, b) => a.person.localeCompare(b.person)),
  };
}

/** 29 Oct — his pile requests the seller has not decided, and his places in pools still filling. */
async function listWaitingOnSeller(
  buyer: InstanceType<typeof Buyer>,
): Promise<BuyerFileWaitingOnSeller[]> {
  const [requests, commitments] = await Promise.all([
    PileRequest.find({ buyerId: buyer._id }),
    PoolCommitment.find({ buyerId: buyer._id, withdrawnAt: null }),
  ]);
  const piles = requests.length
    ? await Pile.find({ _id: { $in: requests.map((r) => r.pileId) }, decision: null })
    : [];
  const pileById = new Map(piles.map((p) => [String(p._id), p]));
  const lines = piles.length
    ? await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } })
    : [];
  const lineById = new Map(lines.map((l) => [String(l._id), l]));
  const pools = commitments.length
    ? await Pool.find({ _id: { $in: commitments.map((c) => c.poolId) }, isActive: true })
    : [];
  const poolById = new Map(pools.map((p) => [String(p._id), p]));
  const poolBoxes = new Map<string, number>();
  if (pools.length) {
    const all = await PoolCommitment.find({
      poolId: { $in: pools.map((p) => p._id) },
      withdrawnAt: null,
    });
    for (const c of all)
      poolBoxes.set(String(c.poolId), (poolBoxes.get(String(c.poolId)) ?? 0) + c.qty);
  }
  const skuIds = [...lines.map((l) => l.skuId), ...pools.map((p) => p.skuId)];
  const skus = skuIds.length ? await Sku.find({ _id: { $in: skuIds } }) : [];
  const skuById = new Map(skus.map((x) => [String(x._id), x]));
  const products = skus.length
    ? await Product.find({ _id: { $in: skus.map((x) => x.productId) } })
    : [];
  const productById = new Map(products.map((x) => [String(x._id), x]));
  const named = (skuId: unknown) => {
    const sku = skuById.get(String(skuId));
    const product = sku ? productById.get(String(sku.productId)) : undefined;
    return {
      productId: product ? String(product._id) : null,
      brand: product?.brand ?? '—',
      packLabel: sku?.packLabel ?? null,
    };
  };

  const rows: BuyerFileWaitingOnSeller[] = [];
  for (const r of requests) {
    const pile = pileById.get(String(r.pileId));
    const line = pile ? lineById.get(String(pile.listingLineId)) : undefined;
    if (!pile || !line) continue;
    rows.push({
      kind: 'pile',
      id: String(r._id),
      ...named(line.skuId),
      qty: r.qty,
      ratePaise: await computeBuyerFacingRatePaise(buyer, line.skuId, line.ratePaise),
      requestedAt: r.requestedAt.toISOString(),
      decideBy: pile.confirmWindowEndsAt.toISOString(),
      pool: null,
    });
  }
  for (const c of commitments) {
    const pool = poolById.get(String(c.poolId));
    if (!pool) continue;
    rows.push({
      kind: 'pool',
      id: String(c._id),
      ...named(pool.skuId),
      qty: c.qty,
      ratePaise: null,
      requestedAt: (c as unknown as { createdAt: Date }).createdAt.toISOString(),
      decideBy: null,
      pool: {
        committedBoxes: poolBoxes.get(String(pool._id)) ?? 0,
        moq: pool.moq,
        status: pool.status,
      },
    });
  }
  return rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}
