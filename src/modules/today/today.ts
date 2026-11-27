import { numberSetting } from '../../db/settings.js';
import {
  BuyerModel,
  ComplaintModel,
  PurchaseOrderModel,
  SellerModel,
  TradeModel,
} from '../../models/index.js';
import type { TradeDoc } from '../trades/commands.js';
import { BUYER_STAGE_LABELS, SELLER_STAGE_LABELS } from '../trades/stages.js';
import { dueOf } from '../trades/view.js';

/**
 * The Controller's Today page (Build 7): what has run past its time and now needs a person. Nothing here is stored:
 * every list is worked out from `trade.dueAt` and the open complaints each time the page is asked for, so it can
 * never disagree with the deal cards. The clocks only SHOW these (SRS §6.5); the Controller decides what to do.
 *
 * The page is for the Controller, Founder and Admin, who see both sides of the wall, so it names buyers and sellers.
 */

const SHOWN = 100; // a long list is a sign that something else is wrong; the page says how many there are

/** Which desk should act on a trade that is overdue (a plain reading of the stage). */
function deskOf(trade: TradeDoc): string {
  const { buyerStage, sellerStage } = trade;
  if (sellerStage === 'S0_DEMAND' || buyerStage === 'B3_PENDING_SELLER' || sellerStage === 'S3_PO')
    return 'Purchase';
  if (sellerStage === 'S5_ARRIVED') return 'Logistics';
  if (buyerStage === 'B9_DISPATCH') return 'The clock';
  if (['B4_SEND_CONFIRMATION', 'B5_BUYERS_CALL', 'B6_ORDER_CONFIRMED'].includes(buyerStage))
    return 'Sales';
  return 'Controller';
}

export async function todayView(now = new Date()) {
  const overdueTrades = await TradeModel.find({ dueAt: { $lte: now } })
    .sort({ dueAt: 1 })
    .limit(SHOWN * 2);

  // Goods still on the road past their arrival time are the Controller's own call (Close as lost in transit).
  const transit = overdueTrades.filter((trade) => trade.sellerStage === 'S5_DISPATCHED');
  // Complaints have their own queue; their overdue count is shown on this page but they are not listed twice.
  const complaintTrades = overdueTrades.filter((trade) => trade.buyerStage === 'B11_COMPLAINTS');
  const others = overdueTrades.filter(
    (trade) => trade.sellerStage !== 'S5_DISPATCHED' && trade.buyerStage !== 'B11_COMPLAINTS',
  );

  const buyers = await BuyerModel.find(
    { _id: { $in: overdueTrades.map((trade) => trade.buyerId) } },
    { number: 1, firmName: 1 },
  );
  const held = await PurchaseOrderModel.find({ hold: { $exists: true, $ne: null } }).sort({
    'hold.at': 1,
  });
  const transitOrders = await PurchaseOrderModel.find({
    tradeId: { $in: transit.map((trade) => trade._id) },
  });
  const sellers = await SellerModel.find(
    {
      _id: {
        $in: [
          ...others.map((trade) => trade.sellerId),
          ...transitOrders.map((po) => po.sellerId),
          ...held.map((po) => po.sellerId),
        ].filter(Boolean),
      },
    },
    { number: 1, firmName: 1 },
  );
  const heldTrades = await TradeModel.find(
    { _id: { $in: held.map((po) => po.tradeId) } },
    { number: 1, version: 1 },
  );

  const buyerOf = (trade: TradeDoc) => {
    const buyer = buyers.find((item) => item._id.equals(trade.buyerId));
    return { number: buyer?.number ?? '', firmName: buyer?.firmName ?? '' };
  };
  const sellerOf = (id: unknown) => {
    const seller = sellers.find((item) => id && item._id.equals(id as never));
    return seller ? { number: seller.number, firmName: seller.firmName } : null;
  };
  const tradeOf = (trade: Pick<TradeDoc, 'id' | 'number' | 'version'>) => ({
    id: trade.id,
    number: trade.number,
    version: trade.version,
  });

  return {
    now,
    // Goods due at the dock that have not arrived: the Close as lost in transit button works on these.
    lostInTransit: transit.slice(0, SHOWN).map((trade) => {
      const po = transitOrders.find((item) => item.tradeId.equals(trade._id));
      return {
        trade: tradeOf(trade),
        buyer: buyerOf(trade),
        seller: sellerOf(po?.sellerId ?? trade.sellerId),
        poNumber: po?.number ?? null,
        boxes: po ? po.lines.reduce((sum, line) => sum + line.boxes, 0) : null,
        dueAt: trade.dueAt!,
      };
    }),
    // Every other clock that has run out. They only show: the desk named acts, or the Controller steps in.
    overdue: others.slice(0, SHOWN).map((trade) => ({
      trade: tradeOf(trade),
      label: dueOf(trade)?.label ?? 'Due',
      desk: deskOf(trade),
      stage: `${BUYER_STAGE_LABELS[trade.buyerStage]}${
        trade.sellerStage ? ` · ${SELLER_STAGE_LABELS[trade.sellerStage]}` : ''
      }`,
      buyer: buyerOf(trade),
      seller: sellerOf(trade.sellerId),
      dueAt: trade.dueAt!,
    })),
    complaints: {
      open: await ComplaintModel.countDocuments({ status: 'OPEN' }),
      overdue: complaintTrades.length,
    },
    // Payouts the Controller put on hold: they stay out of To pay until released.
    held: held.slice(0, SHOWN).map((po) => {
      const trade = heldTrades.find((item) => item._id.equals(po.tradeId));
      return {
        poNumber: po.number,
        seller: sellerOf(po.sellerId),
        reason: po.hold!.reason,
        at: po.hold!.at,
        trade: trade ? tradeOf(trade) : null,
      };
    }),
    // Shown on the page so nobody has to remember the rule.
    archiveDays: await numberSetting('B1_ARCHIVE_DAYS', 7),
  };
}
