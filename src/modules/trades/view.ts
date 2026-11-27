import {
  BuyerModel,
  ListingModel,
  ProductModel,
  PurchaseOrderModel,
  SalesOrderModel,
  SellerModel,
  SkuModel,
  TradeEventModel,
  UserModel,
  type Trade,
} from '../../models/index.js';
import type { Types } from 'mongoose';
import type { Role } from '../../shared/enums.js';
import { BUYER_SIDE_ROLES, SELLER_SIDE_ROLES } from '../parties/permissions.js';
import { computeBuyerRate, loadMargins, pricingTierOf } from '../pricing/pricing.js';
import {
  DESK_NAMES,
  HISTORY_LABELS,
  TRADE_ACTIONS,
  TRADE_ACTION_NAMES,
  canPress,
  isAtStage,
  showsOnCard,
} from './actions.js';
import type { TradeDoc } from './commands.js';
import { acceptedLines, margBillView } from '../billing/billing.js';
import { complaintsOf } from '../complaints/complaints.js';
import { refundsOf } from '../dock/dock.js';
import { advanceOf } from '../payments/advances.js';
import { paymentsOf } from '../payments/payments.js';
import { payoutOfPo } from '../payouts/payouts.js';
import { purchaseOrderSummary } from '../purchaseOrders/purchaseOrders.js';
import { deliveryOf } from '../trips/trips.js';

/**
 * What the API sends about a trade. A trade holds both sides of the visibility wall, so the answer is built
 * per role: the buyer side (buyer, the rate offered to him) only for BUYER_SIDE_ROLES, the seller side (seller,
 * his listing and landed rate) only for SELLER_SIDE_ROLES. The margin is never sent to anyone.
 */

export const seesBuyerSide = (role: Role) => BUYER_SIDE_ROLES.includes(role);
export const seesSellerSide = (role: Role) => SELLER_SIDE_ROLES.includes(role);

/** Purchase sees a trade only once it has reached the seller side. */
export function canSeeTrade(trade: Pick<Trade, 'sellerStage'>, role: Role): boolean {
  return seesBuyerSide(role) || (seesSellerSide(role) && Boolean(trade.sellerStage));
}

/** Who must act next, and by when (shown as a clock on cards and queues). */
export function dueOf(trade: TradeDoc) {
  if (!trade.dueAt) return null;
  if (trade.sellerStage === 'S0_DEMAND')
    return { at: trade.dueAt, label: 'Purchase to find a seller' };
  if (trade.buyerStage === 'B3_PENDING_SELLER')
    return { at: trade.dueAt, label: 'Seller to confirm' };
  if (trade.buyerStage === 'B4_SEND_CONFIRMATION' || trade.buyerStage === 'B5_BUYERS_CALL')
    return { at: trade.dueAt, label: 'Seller holds the stock until' };
  if (trade.buyerStage === 'B6_ORDER_CONFIRMED') return { at: trade.dueAt, label: 'Payment due' };
  if (trade.sellerStage === 'S3_PO') return { at: trade.dueAt, label: 'Seller to dispatch by' };
  if (trade.sellerStage === 'S5_DISPATCHED')
    return { at: trade.dueAt, label: 'Arrives at the dock by' };
  if (trade.sellerStage === 'S5_ARRIVED') return { at: trade.dueAt, label: 'Dock check by' };
  if (trade.buyerStage === 'B9_DISPATCH') return { at: trade.dueAt, label: 'Delivery window ends' };
  if (trade.buyerStage === 'B11_COMPLAINTS')
    return { at: trade.dueAt, label: 'Controller to decide by' };
  return { at: trade.dueAt, label: 'Due' };
}

/**
 * The buttons for this trade: every action possible at its stage, pressable by its desk (or Founder/Admin).
 * `payoutHeld` is whether the seller's payout is on hold; null for a reader who does not see the seller side.
 * The hold buttons are seller side: only the one that applies now is shown, and Sales sees neither.
 * `hasAdvance`: the buyer has an advance to use (buyer side only); it decides whether "Use the buyer's advance" shows.
 */
function actionsFor(trade: TradeDoc, role: Role, payoutHeld: boolean | null, hasAdvance: boolean) {
  const showsNow = (name: string) =>
    name === 'holdPayout'
      ? payoutHeld === false
      : name === 'releaseHold'
        ? payoutHeld === true
        : name === 'useAdvance'
          ? hasAdvance
          : true;
  return TRADE_ACTION_NAMES.filter(
    (name) => showsOnCard(name) && isAtStage(name, trade) && showsNow(name),
  ).map((name) => {
    const rule = TRADE_ACTIONS[name];
    const allowed = canPress(role, name);
    return {
      name,
      label: rule.label,
      allowed,
      ...(allowed ? {} : { reason: `${DESK_NAMES[rule.desk] ?? rule.desk} does this` }),
    };
  });
}

/** The order's payments, what is still due (total − confirmed) and what may still be entered (− waiting ones). */
async function paymentsSummary(order: {
  _id: Types.ObjectId;
  totalPaise: number;
  paidPaise: number;
}) {
  const payments = await paymentsOf(order._id);
  const waiting = payments
    .filter((payment) => payment.status === 'LOGGED')
    .reduce((sum, payment) => sum + payment.amountPaise, 0);
  const balanceDuePaise = order.totalPaise - order.paidPaise;
  return { payments, balanceDuePaise, openPaise: balanceDuePaise - waiting };
}

/** History lines only the seller side may see: a hold on the seller's payout is never shown to Sales. */
const SELLER_ONLY_EVENTS = ['holdPayout', 'releaseHold'];

async function historyFor(trade: TradeDoc, role: Role) {
  const found = await TradeEventModel.find({ tradeId: trade._id }).sort({ at: 1 });
  const events = seesSellerSide(role)
    ? found
    : found.filter((event) => !SELLER_ONLY_EVENTS.includes(event.action));
  const users = await UserModel.find({
    _id: { $in: events.flatMap((event) => (event.actorId ? [event.actorId] : [])) },
  });
  return events.map((event) => ({
    at: event.at,
    action: event.action,
    label: HISTORY_LABELS[event.action] ?? event.action,
    by:
      event.actorRole === 'SYSTEM'
        ? 'System'
        : (users.find((user) => user._id.equals(event.actorId))?.name ?? ''),
    ...(seesBuyerSide(role) && event.buyerNote ? { buyerNote: event.buyerNote } : {}),
    ...(seesSellerSide(role) && event.sellerNote ? { sellerNote: event.sellerNote } : {}),
  }));
}

/** The full deal card for one trade, as `role` may see it. */
export async function tradeView(trade: TradeDoc, role: Role) {
  const product = await ProductModel.findById(trade.productId).orFail();
  const sku = trade.skuId ? await SkuModel.findById(trade.skuId) : null;
  const listing = trade.listingId ? await ListingModel.findById(trade.listingId) : null;

  // The purchase order is read once here: its hold decides the buttons, and the seller side below shows it.
  const purchaseOrder =
    seesSellerSide(role) && trade.purchaseOrderId
      ? await PurchaseOrderModel.findById(trade.purchaseOrderId)
      : null;
  const payoutHeld = seesSellerSide(role) ? Boolean(purchaseOrder?.hold) : null;
  // The buyer's unspent advance matters only while his order waits for payment, and only the buyer side sees it.
  const advance =
    seesBuyerSide(role) && trade.buyerStage === 'B6_ORDER_CONFIRMED'
      ? await advanceOf(trade.buyerId)
      : null;

  const view = {
    id: trade.id,
    number: trade.number,
    source: trade.source,
    buyerStage: trade.buyerStage,
    sellerStage: trade.sellerStage ?? null,
    product: { id: product.id, name: product.name },
    pack: sku ? { id: sku.id, packLabel: sku.packLabel, unitsPerBox: sku.unitsPerBox } : null,
    boxesWanted: trade.boxesWanted ?? null,
    ask: trade.ask ? { reason: trade.ask.reason, note: trade.ask.note ?? null } : null,
    due: dueOf(trade),
    actions: actionsFor(trade, role, payoutHeld, Boolean(advance?.totalPaise)),
    history: await historyFor(trade, role),
    version: trade.version,
    lastActionAt: trade.lastActionAt,
  };

  // --- buyer side of the wall -----------------------------------------------------------------------------
  let buyerSide = {};
  if (seesBuyerSide(role)) {
    const buyer = await BuyerModel.findById(trade.buyerId).orFail();
    // Before the seller answers, show the board rate of the listing (worked out now, like the rate board).
    let boardOffer = null;
    if (listing && sku && !trade.offer) {
      const { tier, indicative } = pricingTierOf(buyer);
      const marginBp = (await loadMargins()).marginFor(sku.skuClass, tier);
      const rate = marginBp === null ? null : computeBuyerRate(listing.ratePaisePerUnit, marginBp);
      boardOffer = {
        buyerRatePaisePerUnit: rate,
        unitsPerBox: listing.unitsPerBoxSnapshot,
        moqBoxes: listing.moqBoxes,
        quantityBoxes: listing.quantityBoxes,
        expiryBand: listing.expiryBand,
        tier,
        indicative,
        live: listing.status === 'ACTIVE' && listing.expiresAt > new Date(),
      };
    }
    const answer = trade.sellerAnswer;
    const order = trade.salesOrderId ? await SalesOrderModel.findById(trade.salesOrderId) : null;
    buyerSide = {
      buyer: { id: buyer.id, number: buyer.number, firmName: buyer.firmName },
      // The buyer's order (b6 onward): a short summary; the full order is on its own page.
      salesOrder: order
        ? {
            id: order.id,
            number: order.number,
            status: order.status,
            totalPaise: order.totalPaise,
            paymentDueAt: order.paymentDueAt,
          }
        : null,
      // Why the trade was lost (Leakage): buyer side only.
      // Payments entered for the order (buyer side only: an amount tells our selling price).
      ...(order
        ? await paymentsSummary(order)
        : { payments: [], balanceDuePaise: null, openPaise: null }),
      // The buyer's advance not yet spent (hand-added payments), while this order waits for payment.
      advance,
      // Money owed back to the buyer after the dock check, and whether a payout batch has paid it.
      refunds: order ? await refundsOf(order._id) : [],
      // Complaints on this trade (Build 6), oldest first, and the last moment the buyer may still complain.
      complaints: await complaintsOf({ tradeId: trade._id }),
      complaintByAt: trade.complaintByAt ?? null,
      // From the dock check on (b8): what was accepted at the buyer's rate, the Marg bill, the trip, delivery.
      billing:
        order &&
        ['B8_BILLED', 'B9_DISPATCH', 'B10_DELIVERED', 'B11_COMPLAINTS'].includes(trade.buyerStage)
          ? {
              accepted: await acceptedLines(order),
              margBill: margBillView(order),
              ...(await deliveryOf(order)),
            }
          : null,
      leakage: trade.leakage
        ? {
            context: trade.leakage.context,
            reasonLabel: trade.leakage.reasonLabel,
            note: trade.leakage.note ?? null,
            at: trade.leakage.at,
          }
        : null,
      boardOffer,
      // After the seller answers: what Sales offers the buyer (no seller name, no seller rate).
      offer:
        trade.offer && answer
          ? {
              boxes: answer.boxes,
              unitsPerBox: answer.unitsPerBox,
              expiryMonth: answer.expiryMonth,
              buyerRatePaisePerUnit: trade.offer.buyerRatePaisePerUnit ?? null,
              boxValuePaise:
                trade.offer.buyerRatePaisePerUnit == null
                  ? null
                  : trade.offer.buyerRatePaisePerUnit * answer.unitsPerBox,
              tier: trade.offer.tier,
              indicative: trade.offer.indicative,
            }
          : null,
    };
  }

  // --- seller side of the wall ----------------------------------------------------------------------------
  let sellerSide = {};
  if (seesSellerSide(role)) {
    const seller = trade.sellerId ? await SellerModel.findById(trade.sellerId) : null;
    const answer = trade.sellerAnswer;
    sellerSide = {
      seller: seller ? { id: seller.id, number: seller.number, firmName: seller.firmName } : null,
      listing: listing
        ? {
            id: listing.id,
            landedPaisePerUnit: listing.ratePaisePerUnit,
            unitsPerBox: listing.unitsPerBoxSnapshot,
            moqBoxes: listing.moqBoxes,
            quantityBoxes: listing.quantityBoxes,
            expiryBand: listing.expiryBand,
            provenance: listing.provenance,
            status: listing.status,
          }
        : null,
      // The purchase order (b7 / s3 onward): seller side only, it holds the seller's rate.
      purchaseOrder: purchaseOrder ? purchaseOrderSummary(purchaseOrder) : null,
      // Where the seller's payment is (Build 5): seller side only, it is the seller's money.
      payout: purchaseOrder ? await payoutOfPo(purchaseOrder) : null,
      sellerAnswer: answer
        ? {
            kind: answer.kind,
            boxes: answer.boxes,
            landedPaisePerUnit: answer.landedPaisePerUnit,
            unitsPerBox: answer.unitsPerBox,
            expiryMonth: answer.expiryMonth,
            batchNumber: answer.batchNumber ?? null,
            moqBoxes: answer.moqBoxes ?? null,
            boxesAvailable: answer.boxesAvailable ?? null,
            at: answer.at,
          }
        : null,
    };
  }

  return { ...view, ...buyerSide, ...sellerSide };
}

/** One row for the funnel lists. `side` picks which party is named. */
export async function tradeRows(trades: TradeDoc[], side: 'buyer' | 'seller') {
  const products = await ProductModel.find({ _id: { $in: trades.map((t) => t.productId) } });
  const skus = await SkuModel.find({
    _id: { $in: trades.flatMap((t) => (t.skuId ? [t.skuId] : [])) },
  });
  const parties =
    side === 'buyer'
      ? await BuyerModel.find({ _id: { $in: trades.map((t) => t.buyerId) } })
      : await SellerModel.find({
          _id: { $in: trades.flatMap((t) => (t.sellerId ? [t.sellerId] : [])) },
        });
  return trades.map((trade) => {
    const partyId = side === 'buyer' ? trade.buyerId : trade.sellerId;
    const party = partyId ? parties.find((p) => p._id.equals(partyId)) : undefined;
    const sku = trade.skuId ? skus.find((s) => s._id.equals(trade.skuId)) : undefined;
    return {
      id: trade.id,
      number: trade.number,
      buyerStage: trade.buyerStage,
      sellerStage: trade.sellerStage ?? null,
      party: party ? { number: party.number, firmName: party.firmName } : null,
      productName: products.find((p) => p._id.equals(trade.productId))?.name ?? '',
      packLabel: sku?.packLabel ?? null,
      boxesWanted: trade.boxesWanted ?? null,
      due: dueOf(trade),
      lastActionAt: trade.lastActionAt,
      /** For screens that act straight from a list row (the reference Confirmations screen). */
      version: trade.version,
      source: trade.source,
      /** Boxes the seller confirmed (the reference's "confirmed take"), once he has answered. */
      confirmedBoxes:
        trade.sellerAnswer?.kind === 'CONFIRMED' ? (trade.sellerAnswer.boxes ?? null) : null,
    };
  });
}
