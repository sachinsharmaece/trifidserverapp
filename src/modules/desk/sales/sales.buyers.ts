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
import { AppError } from '../../../shared/errors.js';
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
  ownerName: string | null;
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
  productHistory: BuyerProductHistoryRow[];
  openAsks: BuyerFileOpenAsk[];
  callLogs: CallLogDto[];
  orders: SalesOrderRow[];
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

  const openAsks = await Ask.find({
    buyerId: buyer._id,
    state: { $nin: ['lapsed', 'withdrawn'] },
  }).sort({
    createdAt: -1,
  });

  const [callLogs, orders] = await Promise.all([
    listCallLogsForBuyer(buyerId),
    listOrders({ buyerId }),
  ]);

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
    productHistory,
    openAsks: openAsks.map((a) => ({
      askId: (a._id as Types.ObjectId).toString(),
      productId: a.productId ? (a.productId as Types.ObjectId).toString() : null,
      skuId: a.skuId ? (a.skuId as Types.ObjectId).toString() : null,
      qty: a.qty,
      state: a.state,
    })),
    callLogs,
    orders,
  };
}
