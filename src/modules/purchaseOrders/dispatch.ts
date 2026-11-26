import { z } from 'zod';
import { PurchaseOrderModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { FREIGHT_TERMS, LEG1_MODES } from '../../shared/enums.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { istDate } from '../payments/payments.js';
import type { CommandContext } from '../trades/commands.js';
import type { PurchaseOrderDoc } from './purchaseOrders.js';

/**
 * Purchase's two steps on a raised PO (Build 3). Both run inside an engine command, so the trade, its history and
 * these PO changes are one transaction.
 *
 *   recordDispatch   leg 1: how the seller sent the goods to Indore (SRS §6.4 `recordLeg1`) → PO DISPATCHED
 *   recordSellerBill the seller's tax invoice for the PO (needed before he is paid; may be entered again)
 */

/** The trade's PO, loaded inside the transaction. */
export async function purchaseOrderOf({ trade, session }: CommandContext) {
  if (!trade.purchaseOrderId) throw conflict('This trade has no purchase order.', 'NO_PO');
  return PurchaseOrderModel.findById(trade.purchaseOrderId).session(session).orFail();
}

/** Saves changes to a PO (version + 1) and its audit line. */
export async function savePurchaseOrder(
  ctx: CommandContext,
  po: PurchaseOrderDoc,
  set: Record<string, unknown>,
  audit: { action: string; before?: Record<string, unknown>; after: Record<string, unknown> },
) {
  const result = await PurchaseOrderModel.updateOne(
    { _id: po._id, version: po.version },
    { $set: set, $inc: { version: 1 } },
    { session: ctx.session, runValidators: true },
  );
  if (result.matchedCount !== 1) {
    throw conflict('Someone else changed this purchase order. Reload and try again.', 'STALE_PO');
  }
  await writeAudit(ctx.req, {
    action: audit.action,
    entityType: 'PurchaseOrder',
    entityId: po.id,
    ...(audit.before ? { before: audit.before } : {}),
    after: audit.after,
    session: ctx.session,
  });
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((text) => text || undefined);

export const dispatchInput = z.object({
  mode: z.enum(LEG1_MODES),
  transporter: optionalText(120),
  lrNumber: optionalText(60),
  lrDate: day.optional(),
  busDetails: optionalText(200),
  driverName: optionalText(100),
  driverMobile: z
    .string()
    .trim()
    .optional()
    .transform((text) => text || undefined)
    .pipe(
      z
        .string()
        .regex(/^\d{10}$/, 'A mobile number has 10 digits.')
        .optional(),
    ),
  note: optionalText(300),
  freightTerms: z.enum(FREIGHT_TERMS),
  freightPaise: z.number().int().min(1, 'Enter the freight.').max(100_000_000_000).optional(),
  dispatchedOn: day,
  /** Per PO line: what the seller says he packed. Lines left out get no declared batch or expiry. */
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        batchDeclared: optionalText(60),
        expiryDeclared: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the expiry month as YYYY-MM.')
          .optional(),
        shortExpiryAgreed: z.boolean().default(false),
      }),
    )
    .default([]),
});
type DispatchInput = z.output<typeof dispatchInput>;

/** The rules that depend on the mode, the freight terms and the PO (422 on the field). */
function checkDispatch(input: DispatchInput, po: PurchaseOrderDoc, today: string) {
  if (input.mode === 'TRANSPORT') {
    if (!input.transporter) throw invalidField('transporter', 'Enter the transport company.');
    if (!input.lrNumber) throw invalidField('lrNumber', 'Enter the LR number.');
  }
  if (input.mode === 'BUS') {
    if (!input.busDetails) throw invalidField('busDetails', 'Enter the bus (operator, number).');
    if (!input.driverMobile) throw invalidField('driverMobile', "Enter the driver's mobile.");
  }
  if (input.mode === 'DEPOT' && !input.note) {
    throw invalidField('note', 'Say which depot and who is bringing the goods.');
  }
  if (input.freightTerms === 'TO_PAY' && !input.freightPaise) {
    throw invalidField('freightPaise', 'Enter the freight we pay at Indore.');
  }
  if (input.freightTerms === 'PAID' && input.freightPaise) {
    throw invalidField('freightPaise', 'Leave the freight empty when the seller paid it.');
  }
  if (input.dispatchedOn > today) {
    throw invalidField('dispatchedOn', 'The dispatch date cannot be in the future.');
  }
  if (input.lrDate && input.lrDate > today) {
    throw invalidField('lrDate', 'The LR date cannot be in the future.');
  }
  input.lines.forEach((line, index) => {
    if (!po.lines.some((poLine) => poLine.lineNo === line.lineNo)) {
      throw invalidField(`lines.${index}.lineNo`, `The PO has no line ${line.lineNo}.`);
    }
  });
}

/** How the goods were sent, in one line for the history: "by transport (VRL, LR 4471)". */
export function leg1Summary(leg1: {
  mode: string;
  transporter?: string | null | undefined;
  lrNumber?: string | null | undefined;
  busDetails?: string | null | undefined;
}) {
  if (leg1.mode === 'TRANSPORT') return `by transport (${leg1.transporter}, LR ${leg1.lrNumber})`;
  if (leg1.mode === 'BUS') return `by bus (${leg1.busDetails})`;
  return 'from the depot';
}

/** Leg 1: the seller sent the goods. PO RAISED → DISPATCHED. */
export async function recordDispatch(ctx: CommandContext, input: DispatchInput) {
  const po = await purchaseOrderOf(ctx);
  if (po.status !== 'RAISED') throw conflict('The dispatch is already recorded.', 'WRONG_STAGE');
  checkDispatch(input, po, istDate(ctx.now));
  const leg1 = {
    ...input,
    lines: po.lines.map((poLine) => {
      const given = input.lines.find((line) => line.lineNo === poLine.lineNo);
      return {
        lineNo: poLine.lineNo,
        ...(given?.batchDeclared ? { batchDeclared: given.batchDeclared } : {}),
        ...(given?.expiryDeclared ? { expiryDeclared: given.expiryDeclared } : {}),
        shortExpiryAgreed: given?.shortExpiryAgreed ?? false,
      };
    }),
    at: ctx.now,
    by: ctx.userId,
  };
  // Drop empty optional fields so the record holds only what was entered.
  const clean = Object.fromEntries(Object.entries(leg1).filter(([, value]) => value !== undefined));
  await savePurchaseOrder(
    ctx,
    po,
    { status: 'DISPATCHED', leg1: clean },
    {
      action: 'purchaseOrder.dispatch',
      before: { status: po.status },
      after: { status: 'DISPATCHED', mode: input.mode, freightTerms: input.freightTerms },
    },
  );
  return { po, leg1 };
}

export const sellerBillInput = z.object({
  number: z.string().trim().min(1, "Enter the seller's bill number.").max(40),
  amountPaise: z.number().int().min(1, 'Enter the bill amount.').max(100_000_000_000),
  billDate: day,
});

/**
 * The seller's tax invoice. Entering it again replaces it (the audit keeps the old one). A bill that differs from
 * the PO total is saved with a warning in the history, never refused (SRS §6.4).
 */
export async function recordSellerBill(
  ctx: CommandContext,
  input: z.output<typeof sellerBillInput>,
) {
  const po = await purchaseOrderOf(ctx);
  if (input.billDate > istDate(ctx.now)) {
    throw invalidField('billDate', 'The bill date cannot be in the future.');
  }
  const bill = { ...input, at: ctx.now, by: ctx.userId };
  await savePurchaseOrder(
    ctx,
    po,
    { sellerBill: bill },
    {
      action: 'purchaseOrder.sellerBill',
      ...(po.sellerBill
        ? { before: { number: po.sellerBill.number, amountPaise: po.sellerBill.amountPaise } }
        : {}),
      after: { number: input.number, amountPaise: input.amountPaise },
    },
  );
  const differs = input.amountPaise !== po.totalPaise;
  const note = `Seller bill ${input.number}: ${formatRupees(input.amountPaise)}${
    differs ? ` (the PO is ${formatRupees(po.totalPaise)}: please check)` : ''
  }`;
  return { po, note, replaced: Boolean(po.sellerBill) };
}
