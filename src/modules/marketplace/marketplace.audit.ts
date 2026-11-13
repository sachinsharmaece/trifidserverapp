import type { Types } from 'mongoose';
import { Ask } from '../../models/Ask.js';
import { Buyer } from '../../models/Buyer.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Listing } from '../../models/Listing.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { OPEN_QUOTE_STATUSES, Quote } from '../../models/Quote.js';
import { Seller } from '../../models/Seller.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { So } from '../../models/So.js';
import { UpcomingReceipt } from '../../models/UpcomingReceipt.js';

/**
 * RECTIFY-01 §3.2 — the read-only data audit that comes before any fix goes live. Seven checks, one
 * CSV each, so the owner can see the size of every defect on real data before a flag is switched on.
 * Nothing here writes: it reads, and returns rows. `now` is a parameter so the 24 h / 48 h / past-TTL
 * boundaries are testable.
 */
type Id = Types.ObjectId;
export type AuditRow = Record<string, string | number>;

export interface AuditCheck {
  key: string;
  title: string;
  columns: readonly string[];
  rows: AuditRow[];
}

const id = (value: unknown): string => String(value);
const hoursBetween = (later: Date, earlier: Date): number =>
  Math.round(((later.getTime() - earlier.getTime()) / 3_600_000) * 10) / 10;

/** Resolves names once per run instead of once per row. */
class Names {
  private pack = new Map<string, string>();
  private buyer = new Map<string, string>();
  private seller = new Map<string, string>();

  async packOf(skuId: unknown): Promise<string> {
    if (!skuId) return '';
    const key = id(skuId);
    if (!this.pack.has(key)) {
      const sku = await Sku.findById(key, { productId: 1, packLabel: 1 });
      const product = sku ? await Product.findById(sku.productId, { brand: 1 }) : null;
      this.pack.set(key, sku ? `${product?.brand ?? ''} ${sku.packLabel}`.trim() : '');
    }
    return this.pack.get(key)!;
  }

  async buyerFirm(buyerId: unknown): Promise<string> {
    const key = id(buyerId);
    if (!this.buyer.has(key)) {
      const buyer = await Buyer.findById(key, { counterpartyId: 1 });
      const counterparty = buyer
        ? await Counterparty.findById(buyer.counterpartyId, { firm: 1 })
        : null;
      this.buyer.set(key, counterparty?.firm ?? '');
    }
    return this.buyer.get(key)!;
  }

  async sellerFirm(sellerId: unknown): Promise<string> {
    const key = id(sellerId);
    if (!this.seller.has(key)) {
      const seller = await Seller.findById(key, { counterpartyId: 1 });
      const counterparty = seller
        ? await Counterparty.findById(seller.counterpartyId, { firm: 1 })
        : null;
      this.seller.set(key, counterparty?.firm ?? '');
    }
    return this.seller.get(key)!;
  }
}

export async function runAudit(now: Date = new Date()): Promise<{
  checks: AuditCheck[];
  /** Orders with a buyer who has no GSTIN: their state cannot be read, so they are not in the CSV. */
  ordersWithNoGstin: number;
}> {
  const names = new Names();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  // 1. Asks open or quoted past their 30-day TTL — the size of A1.
  const staleAsks = await Ask.find({
    state: { $in: ['open', 'quoted'] },
    ttlAt: { $lte: now },
  }).sort({ ttlAt: 1 });
  const asks: AuditRow[] = [];
  for (const ask of staleAsks) {
    asks.push({
      ask_id: id(ask._id),
      buyer: await names.buyerFirm(ask.buyerId),
      pack: await names.packOf(ask.skuId),
      state: ask.state,
      boxes_wanted: ask.qty,
      ttl_at: ask.ttlAt.toISOString(),
      days_past_ttl: Math.floor(hoursBetween(now, ask.ttlAt) / 24),
    });
  }

  // 2. Live quotes past their binding — what the expiry job will close on day one. Sales must be told.
  const pastBinding = await Quote.find({ status: 'live', bindingUntil: { $lte: now } }).sort({
    bindingUntil: 1,
  });
  const bound: AuditRow[] = [];
  for (const quote of pastBinding) {
    const ask = await Ask.findById(quote.askId, { buyerId: 1, skuId: 1, state: 1 });
    bound.push({
      quote_id: id(quote._id),
      ask_id: id(quote.askId),
      buyer: ask ? await names.buyerFirm(ask.buyerId) : '',
      pack: await names.packOf(quote.skuId ?? ask?.skuId),
      boxes: quote.qtyAvailable,
      binding_until: quote.bindingUntil.toISOString(),
      hours_past_binding: hoursBetween(now, quote.bindingUntil),
      ask_state: ask?.state ?? '',
    });
  }

  // 3. Parked quotes older than 24 h — the size of the parked-quote age problem (O1).
  const parkedQuotes = await Quote.find({
    status: 'pending_sales',
    createdAt: { $lte: hoursAgo(24) },
  }).sort({ createdAt: 1 });
  const parked: AuditRow[] = [];
  for (const quote of parkedQuotes) {
    const createdAt = (quote as unknown as { createdAt: Date }).createdAt;
    parked.push({
      quote_id: id(quote._id),
      ask_id: id(quote.askId),
      seller: await names.sellerFirm(quote.sellerId),
      pack: await names.packOf(quote.skuId),
      boxes: quote.qtyAvailable,
      parked_since: createdAt.toISOString(),
      hours_parked: hoursBetween(now, createdAt),
    });
  }

  // 4. Quote-born lines that promise more than the quotes behind them can supply — the size of A11.
  // "Behind a line" is every parked or live quote pointing at it.
  const quoteBorn = await Listing.find({ origin: 'quote_born', state: 'live' }, { sellerId: 1 });
  const sellerOfListing = new Map(quoteBorn.map((l) => [id(l._id), l.sellerId as Id]));
  const bornLines = await ListingLine.find({
    listingId: { $in: quoteBorn.map((l) => l._id) },
    qty: { $gt: 0 },
  });
  const behind = await Quote.aggregate<{ _id: Id; boxes: number }>([
    {
      $match: {
        listingLineId: { $in: bornLines.map((line) => line._id) },
        status: { $in: [...OPEN_QUOTE_STATUSES] },
      },
    },
    { $group: { _id: '$listingLineId', boxes: { $sum: '$qtyAvailable' } } },
  ]);
  const boxesBehind = new Map(behind.map((row) => [id(row._id), row.boxes]));
  const overPromised: AuditRow[] = [];
  for (const line of bornLines) {
    const supply = boxesBehind.get(id(line._id)) ?? 0;
    if (line.qty <= supply) continue;
    overPromised.push({
      listing_line_id: id(line._id),
      listing_id: id(line.listingId),
      seller: await names.sellerFirm(sellerOfListing.get(id(line.listingId))),
      pack: await names.packOf(line.skuId),
      line_boxes: line.qty,
      boxes_open_quotes_can_supply: supply,
      boxes_over: line.qty - supply,
    });
  }

  // 5. Orders marked intra-state whose buyer's GSTIN is not Madhya Pradesh's (state code 23) — A9.
  const intra = await So.find({ placeOfSupply: 'intra_state' }).sort({ createdAt: 1 });
  const wrongSupply: AuditRow[] = [];
  let ordersWithNoGstin = 0;
  const gstinOfBuyer = new Map<string, string | null>();
  for (const order of intra) {
    const key = id(order.buyerId);
    if (!gstinOfBuyer.has(key)) {
      const buyer = await Buyer.findById(key, { counterpartyId: 1 });
      const counterparty = buyer
        ? await Counterparty.findById(buyer.counterpartyId, { gstin: 1 })
        : null;
      gstinOfBuyer.set(key, counterparty?.gstin ?? null);
    }
    const gstin = gstinOfBuyer.get(key);
    if (!gstin) {
      ordersWithNoGstin += 1;
      continue;
    }
    const stateCode = gstin.slice(0, 2);
    if (stateCode === '23') continue;
    wrongSupply.push({
      so_no: order.soNo,
      so_id: id(order._id),
      buyer: await names.buyerFirm(order.buyerId),
      buyer_gstin_state_code: stateCode,
      place_of_supply: order.placeOfSupply,
      order_state: order.state,
      total_paise: order.totalPaise,
      raised_at: (order as unknown as { createdAt: Date }).createdAt.toISOString(),
    });
  }

  // 6. Declared payments still waiting after 48 h — the size of A6.
  const staleReceipts = await UpcomingReceipt.find({
    state: 'waiting',
    claimedAt: { $lte: hoursAgo(48) },
  }).sort({ claimedAt: 1 });
  const receipts: AuditRow[] = [];
  for (const receipt of staleReceipts) {
    receipts.push({
      receipt_id: id(receipt._id),
      buyer: await names.buyerFirm(receipt.buyerId),
      amount_paise: receipt.amountPaise,
      claimed_at: receipt.claimedAt.toISOString(),
      hours_waiting: hoursBetween(now, receipt.claimedAt),
      orders_named: receipt.soIds.length,
    });
  }

  // 7. Piles requoted with buyers still open on them — the stranded buyers today. Sales calls each one.
  const requoted = await Pile.find({ decision: 'requoted' });
  const stranded: AuditRow[] = [];
  if (requoted.length > 0) {
    const open = await PileRequest.find({
      pileId: { $in: requoted.map((pile) => pile._id) },
      offerState: { $in: [null, 'offered'] },
    }).sort({ requestedAt: 1 });
    const pileById = new Map(requoted.map((pile) => [id(pile._id), pile]));
    for (const request of open) {
      const pile = pileById.get(id(request.pileId))!;
      const line = await ListingLine.findById(pile.listingLineId, { skuId: 1 });
      stranded.push({
        pile_id: id(pile._id),
        listing_line_id: id(pile.listingLineId),
        pack: await names.packOf(line?.skuId),
        requoted_at: pile.decidedAt ? pile.decidedAt.toISOString() : '',
        request_id: id(request._id),
        buyer: await names.buyerFirm(request.buyerId),
        boxes: request.qty,
        deal_state: request.offerState ?? 'none given',
      });
    }
  }

  return {
    ordersWithNoGstin,
    checks: [
      {
        key: 'asks-past-ttl',
        title: 'Asks open or quoted with a TTL in the past (A1)',
        columns: ['ask_id', 'buyer', 'pack', 'state', 'boxes_wanted', 'ttl_at', 'days_past_ttl'],
        rows: asks,
      },
      {
        key: 'quotes-live-past-binding',
        title: 'Live quotes whose binding has passed (A2) — Sales must be told',
        columns: [
          'quote_id',
          'ask_id',
          'buyer',
          'pack',
          'boxes',
          'binding_until',
          'hours_past_binding',
          'ask_state',
        ],
        rows: bound,
      },
      {
        key: 'quotes-parked-over-24h',
        title: 'Quotes parked for Sales more than 24 hours (O1)',
        columns: ['quote_id', 'ask_id', 'seller', 'pack', 'boxes', 'parked_since', 'hours_parked'],
        rows: parked,
      },
      {
        key: 'lines-over-quotes',
        title: 'Quote-born lines promising more than their open quotes can supply (A11)',
        columns: [
          'listing_line_id',
          'listing_id',
          'seller',
          'pack',
          'line_boxes',
          'boxes_open_quotes_can_supply',
          'boxes_over',
        ],
        rows: overPromised,
      },
      {
        key: 'orders-wrong-place-of-supply',
        title: 'Orders marked intra-state whose buyer GSTIN state code is not 23 (A9)',
        columns: [
          'so_no',
          'so_id',
          'buyer',
          'buyer_gstin_state_code',
          'place_of_supply',
          'order_state',
          'total_paise',
          'raised_at',
        ],
        rows: wrongSupply,
      },
      {
        key: 'receipts-waiting-over-48h',
        title: 'Declared payments waiting more than 48 hours (A6)',
        columns: [
          'receipt_id',
          'buyer',
          'amount_paise',
          'claimed_at',
          'hours_waiting',
          'orders_named',
        ],
        rows: receipts,
      },
      {
        key: 'piles-requoted-stranded',
        title: 'Requoted piles with buyers still open — Sales calls each one (C)',
        columns: [
          'pile_id',
          'listing_line_id',
          'pack',
          'requoted_at',
          'request_id',
          'buyer',
          'boxes',
          'deal_state',
        ],
        rows: stranded,
      },
    ],
  };
}
