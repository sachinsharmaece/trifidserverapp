import {
  ComplaintModel,
  PurchaseOrderModel,
  ReceiptModel,
  RefundModel,
  SalesOrderModel,
  TradeModel,
  TripModel,
} from '../../models/index.js';
import type { Role } from '../../shared/enums.js';
import { BUYER_STAGES, SELLER_STAGES } from '../../shared/enums.js';
import { istDate } from '../payments/payments.js';
import { BUYER_STAGE_LABELS, SELLER_STAGE_LABELS } from '../trades/stages.js';
import { lastIntegrityRun } from '../system/integrity.js';
import { deskOf } from '../today/today.js';

/**
 * The dashboard (SRS-RPT-05): a few numbers for the person's own desk, worked out fresh each time (nothing is stored).
 * What each role sees follows the wall: Sales counts buyer-side trades only, Purchase seller-side only, Accounts and
 * Logistics see queues with no firm names, and only the Controller, Founder and Admin see money and margin.
 *
 * "Marg queries" and the day-close status (Accounts) are not here: they come with the books build (Build 9).
 */

type Tone = 'normal' | 'warn' | 'bad';

interface Tile {
  key: string;
  label: string;
  value: number;
  /** `count` is shown as a number, `money` is paise shown as rupees. */
  kind: 'count' | 'money';
  tone: Tone;
  hint?: string;
}

interface Funnel {
  title: string;
  rows: { stage: string; label: string; count: number }[];
}

/** A count tile. A zero is always calm; a number above zero takes `tone`. */
function count(
  key: string,
  label: string,
  value: number,
  tone: Tone = 'normal',
  hint?: string,
): Tile {
  return {
    key,
    label,
    value,
    kind: 'count',
    tone: value > 0 ? tone : 'normal',
    ...(hint ? { hint } : {}),
  };
}

function money(key: string, label: string, value: number, hint?: string): Tile {
  return { key, label, value, kind: 'money', tone: 'normal', ...(hint ? { hint } : {}) };
}

/** The integrity tile: the findings of the last run, or a warning when it has never run or crashed. */
function integrityTile(run: Awaited<ReturnType<typeof lastIntegrityRun>>): Tile {
  const base = { key: 'integrity', label: 'Integrity findings', kind: 'count' as const };
  if (!run) return { ...base, value: 0, tone: 'warn', hint: 'The check has not run yet.' };
  if (run.status === 'FAILED') {
    return { ...base, value: 0, tone: 'bad', hint: 'The last check failed to run.' };
  }
  return count('integrity', base.label, run.findingCount, 'bad', 'From the last check.');
}

/** Midnight at the start of today (and of this month) in Indian time, as an instant. */
const startOfDay = (now: Date) => new Date(`${istDate(now)}T00:00:00+05:30`);
const startOfMonth = (now: Date) => new Date(`${istDate(now).slice(0, 8)}01T00:00:00+05:30`);

async function funnel(side: 'buyer' | 'seller'): Promise<Funnel> {
  const field = side === 'buyer' ? 'buyerStage' : 'sellerStage';
  const groups = await TradeModel.aggregate<{ _id: string | null; count: number }>([
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  const countOf = new Map(groups.map((group) => [group._id, group.count]));
  // Open stages only: the leakage, rejected, lost and archived ends are not part of the working funnel.
  const stages = (side === 'buyer' ? BUYER_STAGES : SELLER_STAGES).filter(
    (stage) => !stage.startsWith('X_') && !stage.startsWith('S_'),
  );
  const labels: Record<string, string> =
    side === 'buyer' ? BUYER_STAGE_LABELS : SELLER_STAGE_LABELS;
  return {
    title: side === 'buyer' ? 'Buyer side' : 'Seller side',
    rows: stages.map((stage) => ({
      stage,
      label: labels[stage] ?? stage,
      count: countOf.get(stage) ?? 0,
    })),
  };
}

/** How many overdue trades each desk should act on (the same reading as the Controller's Today page). */
async function overdueByDesk(now: Date) {
  const overdue = await TradeModel.find({ dueAt: { $lte: now } });
  const byDesk = new Map<string, number>();
  for (const trade of overdue) byDesk.set(deskOf(trade), (byDesk.get(deskOf(trade)) ?? 0) + 1);
  return { byDesk, total: overdue.length, overdue };
}

/** Billed orders that are not on a trip yet: Logistics' dispatch queue. */
async function dispatchQueue() {
  const billed = await SalesOrderModel.find({ status: 'BILLED' });
  const onTrips = await TripModel.find(
    { 'bills.salesOrderId': { $in: billed.map((o) => o._id) } },
    { bills: 1 },
  );
  const taken = new Set(
    onTrips.flatMap((trip) => trip.bills.map((bill) => String(bill.salesOrderId))),
  );
  return billed.filter((order) => !taken.has(order.id)).length;
}

/** Paid orders whose goods the dock has checked and Accounts has not billed yet. */
async function toBeBilled() {
  const checked = await PurchaseOrderModel.find({ status: 'CHECKED' }, { salesOrderId: 1 });
  return SalesOrderModel.countDocuments({
    _id: { $in: checked.map((po) => po.salesOrderId) },
    status: 'PAID',
  });
}

/** Order value (what buyers agreed to pay) and the rate difference on it, over orders raised since `since`. */
async function orderTotals(since: Date) {
  const orders = await SalesOrderModel.find(
    { createdAt: { $gte: since }, status: { $ne: 'CANCELLED' } },
    { totalPaise: 1, lines: 1 },
  );
  let valuePaise = 0;
  let marginPaise = 0;
  for (const order of orders) {
    valuePaise += order.totalPaise;
    for (const line of order.lines) {
      marginPaise += line.lineTotalPaise - line.landedPaisePerUnit * line.unitsPerBox * line.boxes;
    }
  }
  return { valuePaise, marginPaise };
}

/** Lost deals this month, by reason: the leakage reasons, plus the dock and the road. */
async function leakageThisMonth(since: Date) {
  const reasons = await TradeModel.aggregate<{ _id: string; count: number }>([
    { $match: { 'leakage.at': { $gte: since } } },
    { $group: { _id: '$leakage.reasonLabel', count: { $sum: 1 } } },
  ]);
  const rows = reasons.map((item) => ({ label: item._id, count: item.count }));
  const dock = await TradeModel.countDocuments({
    buyerStage: 'X_DOCK_REJECTED',
    lastActionAt: { $gte: since },
  });
  const lost = await TradeModel.countDocuments({
    buyerStage: 'X_LOST_IN_TRANSIT',
    lastActionAt: { $gte: since },
  });
  if (dock > 0) rows.push({ label: 'Dock rejected the goods', count: dock });
  if (lost > 0) rows.push({ label: 'Lost in transit', count: lost });
  return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function dashboardView(role: Role, now = new Date()) {
  const tiles: Tile[] = [];
  const funnels: Funnel[] = [];
  let leakage: { label: string; count: number }[] | null = null;
  const overdue = await overdueByDesk(now);
  const awaitingPayment = { status: 'AWAITING_PAYMENT' as const };
  const pastPaymentTime = await SalesOrderModel.countDocuments({
    ...awaitingPayment,
    paymentDueAt: { $lte: now },
  });

  if (role === 'SALES') {
    funnels.push(await funnel('buyer'));
    tiles.push(
      count('overdueDesk', 'Overdue for Sales', overdue.byDesk.get('Sales') ?? 0, 'bad'),
      count(
        'awaitingPayment',
        'Orders awaiting payment',
        await SalesOrderModel.countDocuments(awaitingPayment),
      ),
      count('pastPaymentTime', 'Past their payment time', pastPaymentTime, 'bad'),
    );
  } else if (role === 'PURCHASE') {
    funnels.push(await funnel('seller'));
    tiles.push(
      count('overdueDesk', 'Overdue for Purchase', overdue.byDesk.get('Purchase') ?? 0, 'bad'),
      count(
        'toDispatch',
        'POs waiting for the seller to dispatch',
        await PurchaseOrderModel.countDocuments({ status: 'RAISED' }),
      ),
      count(
        'dispatchLate',
        'Seller is late to dispatch',
        await PurchaseOrderModel.countDocuments({ status: 'RAISED', dispatchDueAt: { $lte: now } }),
        'bad',
      ),
    );
  } else if (role === 'ACCOUNTS') {
    tiles.push(
      count(
        'paymentsToConfirm',
        'Payments waiting for you to post',
        await ReceiptModel.countDocuments({ status: 'LOGGED' }),
        'warn',
      ),
      count('toBeBilled', 'To be billed in Marg', await toBeBilled(), 'warn'),
      count(
        'payablePos',
        'Seller payouts to make',
        await PurchaseOrderModel.countDocuments({
          status: 'CHECKED',
          acceptedValuePaise: { $gt: 0 },
          payoutBatchId: null,
          paidAt: null,
          hold: null, // a released hold is null, a PO never held has none: both match
        }),
        'warn',
      ),
      count(
        'refundsDue',
        'Refunds to pay',
        await RefundModel.countDocuments({ status: 'DUE', payoutBatchId: null }),
        'warn',
      ),
      count('pastPaymentTime', 'Orders past their payment time', pastPaymentTime, 'bad'),
    );
  } else if (role === 'LOGISTICS') {
    tiles.push(
      count(
        'inboundExpected',
        'Inbound, on the way',
        await PurchaseOrderModel.countDocuments({ status: 'DISPATCHED' }),
      ),
      count(
        'inboundLate',
        'Inbound, past the expected day',
        overdue.overdue.filter((trade) => trade.sellerStage === 'S5_DISPATCHED').length,
        'bad',
      ),
      count(
        'atDock',
        'At the dock, to check',
        await PurchaseOrderModel.countDocuments({ status: 'ARRIVED' }),
        'warn',
      ),
      count(
        'checkLate',
        'Dock check is late',
        await PurchaseOrderModel.countDocuments({ status: 'ARRIVED', inspectBy: { $lte: now } }),
        'bad',
      ),
      count('dispatchQueue', 'Billed, waiting for a trip', await dispatchQueue(), 'warn'),
      count(
        'onTheRoad',
        'On the road to buyers',
        await SalesOrderModel.countDocuments({ status: 'DISPATCHED' }),
      ),
    );
  } else {
    // Controller, Founder, Admin: both sides of the wall, money and margin.
    const [today, month] = await Promise.all([
      orderTotals(startOfDay(now)),
      orderTotals(startOfMonth(now)),
    ]);
    const integrity = await lastIntegrityRun();
    funnels.push(await funnel('buyer'), await funnel('seller'));
    leakage = await leakageThisMonth(startOfMonth(now));
    tiles.push(
      money('orderValueToday', 'Order value today', today.valuePaise),
      money('orderValueMonth', 'Order value this month', month.valuePaise),
      money(
        'marginToday',
        'Margin today',
        today.marginPaise,
        'Selling rate minus buying rate; GST is inside both.',
      ),
      money(
        'marginMonth',
        'Margin this month',
        month.marginPaise,
        'Selling rate minus buying rate; GST is inside both.',
      ),
      count(
        'slaBreaches',
        'Clocks that have run out',
        overdue.total,
        'bad',
        'Listed on the Today page.',
      ),
      count(
        'openComplaints',
        'Open complaints',
        await ComplaintModel.countDocuments({ status: 'OPEN' }),
        'warn',
      ),
      count(
        'heldPayouts',
        'Payouts on hold',
        await PurchaseOrderModel.countDocuments({
          hold: { $exists: true, $ne: null },
          paidAt: null,
        }),
        'warn',
      ),
      integrityTile(integrity),
    );
  }
  return { role, generatedAt: now, funnels, tiles, leakage };
}
