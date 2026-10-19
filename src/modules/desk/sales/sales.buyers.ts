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
import { AppError } from '../../../shared/errors.js';
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

export interface BuyerListRow {
  buyerId: string;
  firm: string;
  gstin: string | null;
  tehsil: string | null;
  tier: string | null;
  orderCount: number;
  lastOrderAt: string | null;
  rateViews: number;
  ownerName: string | null; // The Sales employee whose book he is in — not the firm's owner.
  contactName: string | null; // The firm's own owner, from the counterparty.
  mobile: string | null;
}

/** GET /staff/sales/buyers?q=&tab=book|queue */
export async function listBuyers(filters: {
  q?: string;
  tab?: 'book' | 'queue';
}): Promise<BuyerListRow[]> {
  const assignments = await BookAssignment.find({});
  const ownerEmployeeIdByBuyer = new Map(
    assignments.map((a) => [(a.buyerId as Types.ObjectId).toString(), a.ownerEmployeeId]),
  );

  let buyers = await Buyer.find({}).sort({ createdAt: -1 });
  if (filters.tab === 'book') {
    buyers = buyers.filter((b) => ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString()));
  } else if (filters.tab === 'queue') {
    buyers = buyers.filter(
      (b) => !ownerEmployeeIdByBuyer.has((b._id as Types.ObjectId).toString()),
    );
  }

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
        cp?.ownerName?.toLowerCase().includes(q) ||
        cp?.mobile?.toLowerCase().includes(q) ||
        inTehsil,
      );
    });
  }

  const tehsilIds = [
    ...new Set(
      buyers.filter((b) => b.tehsilId).map((b) => (b.tehsilId as Types.ObjectId).toString()),
    ),
  ];
  const tehsils = await Tehsil.find({ _id: { $in: tehsilIds } });
  const tehsilNameById = new Map(
    tehsils.map((t) => [(t._id as Types.ObjectId).toString(), t.name]),
  );

  const employees = await Employee.find({ _id: { $in: [...ownerEmployeeIdByBuyer.values()] } });
  const employeeNameById = new Map(
    employees.map((e) => [(e._id as Types.ObjectId).toString(), e.person]),
  );

  const sos = await So.find({ buyerId: { $in: buyers.map((b) => b._id) } })
    .select('buyerId createdAt')
    .sort({ createdAt: -1 });
  const orderStatsByBuyer = new Map<string, { count: number; lastOrderAt: Date }>();
  for (const so of sos) {
    const key = (so.buyerId as Types.ObjectId).toString();
    const createdAt = (so as unknown as { createdAt: Date }).createdAt;
    const existing = orderStatsByBuyer.get(key);
    if (existing) existing.count += 1;
    else orderStatsByBuyer.set(key, { count: 1, lastOrderAt: createdAt }); // sorted desc — the first hit is the latest.
  }

  return buyers.map((b) => {
    const idStr = (b._id as Types.ObjectId).toString();
    const cp = counterpartyById.get((b.counterpartyId as Types.ObjectId).toString());
    const ownerEmployeeId = ownerEmployeeIdByBuyer.get(idStr);
    const stats = orderStatsByBuyer.get(idStr);
    return {
      buyerId: idStr,
      firm: cp?.firm ?? '',
      gstin: cp?.gstin ?? null,
      contactName: cp?.ownerName ?? null,
      mobile: cp?.mobile ?? null,
      tehsil: b.tehsilId
        ? (tehsilNameById.get((b.tehsilId as Types.ObjectId).toString()) ?? null)
        : null,
      tier: b.isTrader
        ? 'Trader'
        : b.tradePosition
          ? capitalizeTradePosition(b.tradePosition)
          : null,
      orderCount: stats?.count ?? 0,
      lastOrderAt: stats?.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
      rateViews: b.rateViews,
      ownerName: ownerEmployeeId
        ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null)
        : null,
    };
  });
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
}

/** A live quote on one of his asks — the rate he is holding right now. */
export interface BuyerFileLiveQuote {
  quoteId: string;
  askId: string;
  productId: string | null;
  brand: string;
  packLabel: string | null;
  ratePaiseForIndore: number;
  qtyAvailable: number;
  /** How many boxes he asked for — what Confirm compares the quote against. */
  askQty: number;
  daysToIndore: number;
  /** When the rate was given to him; the desk shows it as "15 minutes ago". */
  givenAt: string;
  bindingUntil: string;
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
  const liveQuoteRows: BuyerFileLiveQuote[] = liveQuotes.map((q) => {
    const ask = askById.get((q.askId as Types.ObjectId).toString());
    const productId = ask ? askProductIdOf(ask) : null;
    const sku = ask?.skuId ? askSkuById.get((ask.skuId as Types.ObjectId).toString()) : undefined;
    return {
      quoteId: (q._id as Types.ObjectId).toString(),
      askId: (q.askId as Types.ObjectId).toString(),
      productId,
      brand: (productId ? askProductById.get(productId)?.brand : undefined) ?? '—',
      packLabel: sku?.packLabel ?? null,
      ratePaiseForIndore: q.ratePaiseForIndore,
      qtyAvailable: q.qtyAvailable,
      askQty: ask?.qty ?? q.qtyAvailable,
      daysToIndore: q.daysToIndore,
      givenAt: (q as unknown as { createdAt: Date }).createdAt.toISOString(),
      bindingUntil: q.bindingUntil.toISOString(),
    };
  });

  // The same nine joints as the Funnel tab, with the same state lists and wording,
  // counted over this buyer's own records only.
  const staleBefore = addDays(new Date(), -(ASK_LEAK_STALENESS_HOURS / 24));
  const askLeakCount = openAsks.filter(
    (a) => a.state === 'open' && (a as unknown as { createdAt: Date }).createdAt <= staleBefore,
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
    mobile: counterparty?.mobile ?? '',
    tehsil: tehsil?.name ?? null,
    tier: buyer.isTrader
      ? 'Trader'
      : buyer.tradePosition
        ? capitalizeTradePosition(buyer.tradePosition)
        : null,
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
      };
    }),
    liveQuotes: liveQuoteRows,
    callLogs,
    orders,
    ordersByStage,
  };
}
