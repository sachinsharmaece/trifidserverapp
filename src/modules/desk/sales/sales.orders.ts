import type { Types } from 'mongoose';
import { So, type SoState } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { UpcomingReceipt } from '../../../models/UpcomingReceipt.js';
import { Chain } from '../../../models/Chain.js';

// BR-030/031 — `chain.stage` is the coarse, seven-step strip position
// (`so → payment → po → leg1 → marg → dispatch → done`); `so.state` above
// carries the finer ST-01 state. Re-declared here rather than imported from
// `models/Chain.ts` only because that file exports no named type for it.
export type ChainStage = 'so' | 'payment' | 'po' | 'leg1' | 'marg' | 'dispatch' | 'done';

// BR-060 — this list carries no `sellerId` and nothing seller-derived,
// matching `SalesWorkItem` (sales.service.ts) and every other Sales-facing
// row in this module.
export interface SalesOrderRow {
  soId: string;
  soNo: string;
  // B-56 — the only screens that ever showed staff a chain id (Chain Desk,
  // Enquiry detail, this row's own now-commented-out progress strip) are
  // unrouted per the 2026-10-02 Enquiry/Chain pivot, leaving the "Record a
  // dispatch" screen's required Chain ID field with no surviving source.
  // Surfaced here since this is the one order-list screen still reachable.
  chainId: string;
  buyerId: string;
  buyerCounterpartyId: string;
  buyerFirm: string;
  productDisplay: string;
  totalPaise: number;
  state: SoState;
  chainStage: ChainStage;
  payDeadline: string;
  // BR-012 — Sales, not Accounts, picks which SO an `UpcomingReceipt` covers.
  // True when a buyer of this order has a claim still `waiting` that has not
  // yet named this SO — i.e. money is in and nobody has pointed it here yet.
  claimNeedsApplying: boolean;
  // The matching `UpcomingReceipt._id` when `claimNeedsApplying` is true —
  // what the Sales-desk Orders screen passes to `allocateUpcomingReceipt`.
  upcomingReceiptId: string | null;
  claimedAt: string | null;
  claimedAmountPaise: number | null;
}

const CLOSED_SO_STATES: SoState[] = ['delivered', 'closed', 'cancelled', 'supply_failed'];

/** GET /staff/sales/orders?tab=live|closed — optionally scoped to one buyer for the buyer file. */
export async function listOrders(filters: {
  tab?: 'live' | 'closed';
  buyerId?: string;
}): Promise<SalesOrderRow[]> {
  const query: Record<string, unknown> = {};
  if (filters.tab === 'closed') query.state = { $in: CLOSED_SO_STATES };
  else if (filters.tab === 'live') query.state = { $nin: CLOSED_SO_STATES };
  if (filters.buyerId) query.buyerId = filters.buyerId;

  const sos = await So.find(query).sort({ createdAt: -1 }).limit(500);
  if (sos.length === 0) return [];

  const buyerIds = [...new Set(sos.map((so) => (so.buyerId as Types.ObjectId).toString()))];
  const buyers = await Buyer.find({ _id: { $in: buyerIds } });
  const buyerById = new Map(buyers.map((b) => [(b._id as Types.ObjectId).toString(), b]));
  const counterparties = await Counterparty.find({
    _id: { $in: buyers.map((b) => b.counterpartyId) },
  });
  const firmByCounterpartyId = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '']),
  );

  const lines = await SoLine.find({ soId: { $in: sos.map((so) => so._id) } });
  const firstLineBySo = new Map<string, InstanceType<typeof SoLine>>();
  for (const line of lines) {
    const key = (line.soId as Types.ObjectId).toString();
    if (!firstLineBySo.has(key)) firstLineBySo.set(key, line);
  }
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));

  const receipts = await UpcomingReceipt.find({ buyerId: { $in: buyerIds } });

  const chains = await Chain.find({ _id: { $in: sos.map((so) => so.chainId) } });
  const chainById = new Map(chains.map((c) => [(c._id as Types.ObjectId).toString(), c]));

  return sos.map((so) => {
    const soIdStr = (so._id as Types.ObjectId).toString();
    const buyerIdStr = (so.buyerId as Types.ObjectId).toString();
    const buyer = buyerById.get(buyerIdStr);
    const firm = buyer
      ? (firmByCounterpartyId.get((buyer.counterpartyId as Types.ObjectId).toString()) ?? '')
      : '';

    const line = firstLineBySo.get(soIdStr);
    const sku = line ? skuById.get((line.skuId as Types.ObjectId).toString()) : undefined;
    const product = sku ? productById.get((sku.productId as Types.ObjectId).toString()) : undefined;
    const productDisplay = product && sku ? `${product.brand} — ${sku.packLabel}` : '';

    const buyerReceipts = receipts.filter(
      (r) => (r.buyerId as Types.ObjectId).toString() === buyerIdStr,
    );
    const appliedClaim = buyerReceipts.find((r) =>
      r.soIds.some((id) => (id as Types.ObjectId).toString() === soIdStr),
    );
    const waitingClaim = buyerReceipts.find(
      (r) =>
        r.state === 'waiting' &&
        !r.soIds.some((id) => (id as Types.ObjectId).toString() === soIdStr),
    );

    const chain = chainById.get((so.chainId as Types.ObjectId).toString());

    return {
      soId: soIdStr,
      soNo: so.soNo,
      chainId: (so.chainId as Types.ObjectId).toString(),
      buyerId: buyerIdStr,
      buyerCounterpartyId: buyer ? (buyer.counterpartyId as Types.ObjectId).toString() : '',
      buyerFirm: firm,
      productDisplay,
      totalPaise: so.totalPaise,
      state: so.state as SoState,
      chainStage: (chain?.stage ?? 'so') as ChainStage,
      payDeadline: so.payDeadline.toISOString(),
      claimNeedsApplying: Boolean(waitingClaim),
      upcomingReceiptId: waitingClaim ? (waitingClaim._id as Types.ObjectId).toString() : null,
      claimedAt: appliedClaim ? appliedClaim.claimedAt.toISOString() : null,
      claimedAmountPaise: appliedClaim ? appliedClaim.amountPaise : null,
    };
  });
}
