import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { RefundModel, SalesOrderModel, SellerStrikeModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { clip } from '../../shared/text.js';
import { istDate } from '../payments/payments.js';
import { purchaseOrderOf, savePurchaseOrder } from '../purchaseOrders/dispatch.js';
import type { CommandContext } from '../trades/commands.js';

/**
 * Lost in transit (LOCK-40 O8, SRS-LOG-05). The goods were sent but never reached the Indore dock. Only the Controller
 * (or Founder or Admin) closes it, and only once the arrival clock has run out (TRANSIT_OVERDUE_DAYS after dispatch).
 * It is like "the dock accepted nothing" (O4), without a dock check or a return note:
 *   - the PO becomes LOST (nothing is owed to the seller: no PURCHASE voucher was ever posted)
 *   - a strike is recorded against the seller (kind LOST_IN_TRANSIT)
 *   - the buyer is owed all his money back: one refund for every box, paid later from Payouts
 * The trade goes to "Lost in transit" / Closed; Sales may reopen it.
 */

export const lostInput = z.object({
  note: z
    .string()
    .trim()
    .min(1, 'Say what you found out, e.g. "Transporter confirmed the truck never reached Indore".')
    .max(250),
});

export async function closeLostInTransit(ctx: CommandContext, input: z.output<typeof lostInput>) {
  const { req, trade, userId, now, session } = ctx;
  const po = await purchaseOrderOf(ctx);
  if (po.status !== 'DISPATCHED') {
    throw conflict('Only goods that are still on the way can be closed as lost.', 'WRONG_STAGE');
  }
  // The arrival clock (set at dispatch) must have run out.
  if (!trade.dueAt || trade.dueAt > now) {
    throw conflict(
      `The goods are not overdue yet: they are due at the dock by ${trade.dueAt ? istDate(trade.dueAt) : 'a date not set'}.`,
      'NOT_OVERDUE',
    );
  }

  const order = await SalesOrderModel.findById(po.salesOrderId).session(session).orFail();
  const orderLine = order.lines[0]!;
  const amountPaise = orderLine.boxes * orderLine.unitsPerBox * orderLine.buyerRatePaisePerUnit;

  const [refund] = await RefundModel.create(
    [
      {
        number: await nextDocumentNumber('REF', { session, at: now }),
        buyerId: order.buyerId,
        salesOrderId: order._id,
        tradeId: trade._id,
        reason: `Lost in transit: ${orderLine.boxes} boxes (${order.number})`,
        boxes: orderLine.boxes,
        amountPaise,
        createdBy: userId,
      },
    ],
    { session },
  );
  if (!refund) throw new Error('The refund was not saved');
  await writeAudit(req, {
    action: 'refund.create',
    entityType: 'Refund',
    entityId: refund.id,
    after: { number: refund.number, amountPaise, salesOrder: order.number },
    session,
  });

  await SellerStrikeModel.create(
    [
      {
        sellerId: po.sellerId,
        purchaseOrderId: po._id,
        kind: 'LOST_IN_TRANSIT',
        at: now,
        by: userId,
      },
    ],
    { session },
  );

  await savePurchaseOrder(
    ctx,
    po,
    { status: 'LOST', lostAt: now },
    {
      action: 'purchaseOrder.lostInTransit',
      before: { status: po.status },
      after: { status: 'LOST', note: input.note },
    },
  );

  return { refund: { number: refund.number, amountPaise }, poNumber: po.number };
}

/** The trade's history lines: the buyer's (with his refund) and the seller's (with the strike). */
export function lostNotes(
  result: Awaited<ReturnType<typeof closeLostInTransit>>,
  input: z.output<typeof lostInput>,
) {
  return {
    buyerNote: `Goods lost in transit. Full refund due to the buyer: ${formatRupees(result.refund.amountPaise)} (${result.refund.number}).`,
    // The Controller's own words go last: a history note is capped, and a long note is the part that is cut.
    sellerNote: clip(
      `Closed as lost in transit by the Controller. Seller strike recorded. ${input.note}`,
    ),
  };
}
