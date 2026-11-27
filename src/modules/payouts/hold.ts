import { z } from 'zod';
import { conflict } from '../../shared/errors.js';
import { purchaseOrderOf, savePurchaseOrder } from '../purchaseOrders/dispatch.js';
import type { CommandContext } from '../trades/commands.js';

/**
 * A hold on a seller's payout (SRS §6.4 `holdPO` / `releaseHold`, Build 7). The Controller (or Founder or Admin) may
 * stop paying a seller, for example while a dispute is sorted out, and later release the hold. A held PO shows
 * "On hold: <reason>" in To pay and cannot go into a payout batch. The hold is seller side only: Sales never sees it.
 * It can be placed from the dock check (s6) until the seller is paid; a PO already in a batch is cancelled out of
 * the batch first (the batch's own Cancel), so a hold never changes a batch that is moving.
 */

export const holdInput = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why the payout is held, e.g. "Seller disputes the return note".')
    .max(250),
});

export async function holdPayout(ctx: CommandContext, input: z.output<typeof holdInput>) {
  const po = await purchaseOrderOf(ctx);
  if (po.hold) throw conflict(`${po.number} is already on hold.`, 'ALREADY_ON_HOLD');
  if (po.paidAt) throw conflict(`${po.number} is already paid.`, 'ALREADY_PAID');
  if (po.payoutBatchId) {
    throw conflict(
      `${po.number} is in a payout batch. Cancel the batch (or take it out) before holding it.`,
      'ALREADY_IN_BATCH',
    );
  }
  await savePurchaseOrder(
    ctx,
    po,
    { hold: { reason: input.reason, at: ctx.now, by: ctx.userId } },
    {
      action: 'purchaseOrder.hold',
      after: { held: true, reason: input.reason },
    },
  );
  return { poNumber: po.number };
}

export async function releaseHold(ctx: CommandContext) {
  const po = await purchaseOrderOf(ctx);
  if (!po.hold) throw conflict(`${po.number} is not on hold.`, 'NOT_ON_HOLD');
  await savePurchaseOrder(
    ctx,
    po,
    { hold: null },
    {
      action: 'purchaseOrder.releaseHold',
      before: { held: true, reason: po.hold.reason },
      after: { held: false },
    },
  );
  return { poNumber: po.number, reason: po.hold.reason };
}
