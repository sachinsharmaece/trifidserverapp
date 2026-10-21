import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { So } from '../../../models/So.js';
import { Seller } from '../../../models/Seller.js';
import { Sku } from '../../../models/Sku.js';
import { Bankbook } from '../../../models/Bankbook.js';
import { UpcomingReceipt } from '../../../models/UpcomingReceipt.js';
import { PoolCommitment } from '../../../models/PoolCommitment.js';
import { AppError } from '../../../shared/errors.js';
import { appendProxyLog } from '../../../shared/proxyLog.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { withTransaction } from '../../../db/transaction.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { writeChainEvent } from '../../chain/chain.events.js';
import { closeDeliveredSo, createPo } from '../../chain/chain.service.js';
import { keyMargInvoice } from '../../marg/marg.service.js';
import { recordMovement } from '../../movement/movement.service.js';
import { applyInspection, recordInspection } from '../../dock/dock.service.js';
import { isMargValueMatched } from '../../../shared/pricing.js';
import { Po } from '../../../models/Po.js';
import { PoLine } from '../../../models/PoLine.js';
import { Inspection } from '../../../models/Inspection.js';
import { postQuote, releaseQuote } from '../../demand/demand.service.js';
import { listPricedLinesVisibleToBuyerDoc } from '../../listing/listing.service.js';
import { syncEnquiryForAsk } from '../../enquiry/enquiry.sync.js';
import {
  allocateUpcomingReceipt,
  createUpcomingReceipt,
  getPostedReceiptsPaiseForSo,
  postBankCredit,
  type StaffActor,
} from '../../payment/payment.service.js';

/**
 * Buyer file stage buttons — the Sales desk moving one enquiry to its next section by hand.
 * "He wants it", "Confirm", "Walk away" reuse the proxy endpoints as they are; this file
 * holds the three moves that had no endpoint: giving a rate, taking payment, cancelling.
 * Each one calls the same service the normal flow calls — nothing here flips a state field.
 */

// A seller's board line states a delivery band, not a day count; a quote needs one. The two
// bands are "48h" and "2-5d", so the band's own upper bound is used.
const DAYS_TO_INDORE_BY_BAND = { '48h': 2, '2-5d': 5 } as const;

/**
 * He asked → Rate given. Sales gives the buyer one of the lines on his board as the rate.
 * The quote is created through `postQuote` (the seller's own path), so the hold, the
 * `rate_ready` notice, the gap codes and the enquiry sync all happen exactly as for a
 * seller's quote. Sales never sees or types a seller: the line id names the supply.
 */
export async function giveRateOnAsk(
  askId: string,
  input: { listingLineId: string },
  actor: StaffActor,
  callNote: string,
): Promise<{ quoteId: string }> {
  assertValidObjectId(askId, 'askId');
  assertValidObjectId(input.listingLineId, 'listingLineId');
  const ask = await Ask.findById(askId);
  if (!ask) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Ask not found.' });
  if (ask.state !== 'open' && ask.state !== 'quoted') {
    throw new AppError({ code: 'ENQUIRY_NOT_OPEN', messageEn: 'This ask is no longer open.' });
  }

  // Only a line that really reaches this buyer can be given to him (the "On the board for
  // him" rule), which also covers a paused or withdrawn listing.
  const visible = await listPricedLinesVisibleToBuyerDoc(
    (ask.buyerId as Types.ObjectId).toString(),
  );
  const picked = visible.find(
    (p) => (p.line._id as Types.ObjectId).toString() === input.listingLineId,
  );
  if (!picked) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That rate is not on the board for this buyer.',
      field: 'listingLineId',
    });
  }
  const { line, listing } = picked;

  const lineSkuId = (line.skuId as Types.ObjectId).toString();
  if (ask.skuId) {
    if ((ask.skuId as Types.ObjectId).toString() !== lineSkuId) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'That rate is for a different pack than the one he asked for.',
        field: 'listingLineId',
      });
    }
  } else {
    const sku = await Sku.findById(line.skuId);
    const lineProductId = sku?.productId ? (sku.productId as Types.ObjectId).toString() : null;
    if (!ask.productId || lineProductId !== (ask.productId as Types.ObjectId).toString()) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'That rate is for a different product than the one he asked for.',
        field: 'listingLineId',
      });
    }
    // Confirming a quote raises its order against `ask.skuId`; a product-level ask has none,
    // so giving him a rate on one pack settles the ask on that pack.
    ask.skuId = line.skuId;
    await ask.save();
  }

  // This line may be the very offer already quoted on his ask (a quote is published as a listing
  // line the moment it is raised). Giving it then gives that quote — never a second one.
  const parked = await Quote.findOne({
    askId: ask._id,
    status: 'pending_sales',
    listingLineId: line._id,
  });
  if (parked) return giveParkedQuote((parked._id as Types.ObjectId).toString(), actor, callNote);

  const seller = await Seller.findById(listing.sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });

  const result = await postQuote((seller.counterpartyId as Types.ObjectId).toString(), askId, {
    ratePaiseForIndore: line.ratePaise,
    qtyAvailable: Math.max(1, Math.min(line.qty, ask.qty)),
    expiryBand: line.expiryBand,
    expiryExact: line.expiryExact ?? line.expiryBand,
    deliveryBand: line.deliveryBand,
    provenance: line.provenance,
    ...(line.batch ? { batch: line.batch } : {}),
    daysToIndore: DAYS_TO_INDORE_BY_BAND[line.deliveryBand],
  });
  await appendProxyLog(Quote, result.quoteId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'give_rate',
  });
  await appendProxyLog(Ask, askId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'give_rate',
  });
  return result;
}

/**
 * He asked → Rate given, from a quote a seller (or Purchase, on his behalf) has already raised.
 * The quote has been a listing line since the moment it was raised; this is the step where the
 * asking buyer is shown it as a rate on his ask. Any number can be given on one ask.
 */
export async function giveParkedQuote(
  quoteId: string,
  actor: StaffActor,
  callNote: string,
): Promise<{ quoteId: string }> {
  const result = await releaseQuote(quoteId);
  await appendProxyLog(Quote, result.quoteId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'give_rate',
  });
  await appendProxyLog(Ask, result.askId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'give_rate',
  });
  return { quoteId: result.quoteId };
}

async function loadOpenOrder(soId: string) {
  assertValidObjectId(soId, 'soId');
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (so.state !== 'awaiting_payment' && so.state !== 'payment_verifying') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This order is no longer waiting on payment.',
    });
  }
  return so;
}

/**
 * Payment pending → Paid. Sales has the buyer's UTR and records it as the money in: one
 * receipt for the balance, pointed at this order, posted to the bankbook against the UTR,
 * then the PO released (INV-01 holds because the receipt now covers the total). Every step
 * is the existing service, so the ledger, audit trail and PO guards all still apply.
 * A failure after the receipt posts is safe to retry: the balance is then zero and only the
 * PO release is left to do.
 */
export async function markOrderPaid(
  soId: string,
  input: { utr: string },
  actor: StaffActor,
  callNote: string,
): Promise<{ poId: string; poNo: string }> {
  const so = await loadOpenOrder(soId);
  const utr = input.utr.trim();

  const posted = await getPostedReceiptsPaiseForSo(soId);
  const balancePaise = so.totalPaise - posted;

  if (balancePaise > 0) {
    if (await Bankbook.exists({ utr })) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'That UTR is already posted against another payment.',
        field: 'utr',
      });
    }
    // A retry after a half-finished attempt reuses its claim rather than raising a second one.
    const existing = await UpcomingReceipt.findOne({
      buyerId: so.buyerId,
      utr,
      state: 'waiting',
    });
    let receiptId: string;
    if (existing) {
      receiptId = (existing._id as Types.ObjectId).toString();
    } else {
      ({ upcomingReceiptId: receiptId } = await createUpcomingReceipt(
        (so.buyerId as Types.ObjectId).toString(),
        { amountPaise: balancePaise, method: 'utr', utr },
      ));
    }
    const receipt = await UpcomingReceipt.findById(receiptId);
    if (!receipt?.soIds || receipt.soIds.length === 0) {
      await allocateUpcomingReceipt(receiptId, [soId], actor);
    }
    await postBankCredit(receiptId, { utr }, actor);
  }

  const po = await createPo(soId, actor);
  await appendProxyLog(So, soId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'mark_paid',
  });
  return po;
}

async function loadOrderInState(soId: string, state: string, message: string) {
  assertValidObjectId(soId, 'soId');
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (so.state !== state) {
    throw new AppError({ code: 'CHAIN_STAGE_GUARD_FAILED', messageEn: message });
  }
  return so;
}

/**
 * Paid → Billed. Sales keys the Marg invoice through `keyMargInvoice`, so its guards stay:
 * the order must already be `inspected` (the dock's finding is never faked from here), and
 * the invoice value must sit within ₹5 of the order total — a mismatch is recorded as a
 * query, books nothing and advances nothing, with no override (BR-033).
 */
export async function markOrderBilled(
  soId: string,
  input: { margInvoiceNo: string; date: Date; valuePaise: number; ewayNo: string },
  actor: StaffActor,
  callNote: string,
): Promise<{ margBillId: string; state: 'matched' | 'query' }> {
  const result = await keyMargInvoice(soId, input, actor);
  if (result.state === 'matched') {
    await appendProxyLog(So, soId, {
      actingStaffId: actor.employeeId,
      callNote,
      action: 'mark_billed',
    });
  }
  return result;
}

const SKIP_MARKER = 'Recorded by Sales — not physically verified';

/**
 * INTERIM — Paid → Billed in one go, for an order whose leg 1 and dock inspection nobody has
 * recorded. Each skipped step is still written through its own service (leg 1 movement, an
 * all-accepted inspection, Purchase's apply, then the Marg invoice), so every later guard
 * has the records it needs; they are marked as recorded by Sales. Applying the inspection
 * books the seller's bill, so the seller's payout stays behind Accounts' receipt
 * confirmation and the Controller's release. The Marg value is checked up front so a
 * mismatch changes nothing.
 */
export async function skipToBilled(
  soId: string,
  input: {
    margInvoiceNo: string;
    date: Date;
    valuePaise: number;
    ewayNo: string;
    legOneRef?: string;
  },
  actor: StaffActor,
  callNote: string,
): Promise<{ margBillId: string; state: 'matched' | 'query' }> {
  assertValidObjectId(soId, 'soId');
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (!['po_released', 'dispatched_leg1', 'at_indore', 'inspected'].includes(so.state)) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: 'Only a paid order that is not yet billed can be moved to Billed.',
    });
  }
  if (!isMargValueMatched(input.valuePaise, so.totalPaise)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'The invoice value must be within ₹5 of the order total — nothing was changed.',
      field: 'valuePaise',
    });
  }
  const po = await Po.findOne({ soId: so._id });
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'No PO found for this order.' });
  const poId = (po._id as Types.ObjectId).toString();

  if (so.state === 'po_released') {
    await recordMovement(
      (so.chainId as Types.ObjectId).toString(),
      {
        leg: 1,
        mode: 'transport',
        lr: input.legOneRef?.trim() || SKIP_MARKER,
        freightTerms: 'prepaid',
        freightAmountPaise: 0,
      },
      actor,
    );
  }
  if (so.state !== 'inspected') {
    const poLine = await PoLine.findOne({ poId: po._id });
    if (!poLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO line not found.' });
    if (!(await Inspection.exists({ poId: po._id }))) {
      await recordInspection(
        poId,
        { casesAccepted: poLine.boxes, casesRejected: 0, reasons: [], photoRefs: [] },
        actor,
      );
    }
    await applyInspection(poId, actor);
  }

  const result = await keyMargInvoice(soId, input, actor);
  await appendProxyLog(So, soId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'skip_to_billed',
  });
  return result;
}

/** Billed → Dispatch. Leg 2 leaving Indore, through the same `recordMovement` Logistics uses. */
export async function dispatchOrder(
  soId: string,
  input: Omit<Parameters<typeof recordMovement>[1], 'leg'>,
  actor: StaffActor,
  callNote: string,
): Promise<{ movementId: string }> {
  const so = await loadOrderInState(
    soId,
    'billed_in_marg',
    'Only an order billed in Marg and not yet dispatched can be sent on leg 2.',
  );
  const result = await recordMovement(
    (so.chainId as Types.ObjectId).toString(),
    { ...input, leg: 2 },
    actor,
  );
  await appendProxyLog(So, soId, { actingStaffId: actor.employeeId, callNote, action: 'dispatch' });
  return result;
}

/**
 * Dispatch → Delivered. The buyer's own "I have it" tap, recorded by Sales from a call: the
 * same `closeDeliveredSo` the tap and the 7-day clock use. It ends his complaint window, so
 * the call note must say he confirmed.
 */
export async function markOrderDelivered(
  soId: string,
  actor: StaffActor,
  callNote: string,
): Promise<{ closed: true }> {
  await loadOrderInState(
    soId,
    'dispatched_leg2',
    'Only an order that has left Indore on leg 2 can be marked delivered.',
  );
  const closed = await closeDeliveredSo(
    soId,
    { actorId: actor.employeeId, actorType: 'staff' },
    actor.correlationId,
  );
  if (!closed) {
    throw new AppError({
      code: 'ORDER_NOT_YET_DELIVERABLE',
      messageEn: 'This order can no longer be marked delivered (it may have a complaint open).',
    });
  }
  await appendProxyLog(So, soId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'mark_delivered',
  });
  return { closed: true };
}

/**
 * Payment pending → gone. Sales cancels an order the buyer will not pay. Refused once any
 * money is posted or claimed against it, and for a pool order (those need the seller's
 * decision, BR-158). No buyer strike: this is a staff decision on a call, not a lapsed window.
 */
export async function cancelOrder(
  soId: string,
  actor: StaffActor,
  callNote: string,
): Promise<{ cancelled: true }> {
  const so = await loadOpenOrder(soId);
  if ((await getPostedReceiptsPaiseForSo(soId)) > 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Money is already posted against this order, so it cannot be cancelled here.',
    });
  }
  if (await PoolCommitment.exists({ soId: so._id })) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This is a pool order — it needs the seller’s decision, not a cancel.',
    });
  }
  if (await UpcomingReceipt.exists({ soIds: so._id, state: 'waiting' })) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A payment claim is waiting on this order — clear it before cancelling.',
    });
  }

  await withTransaction(async (session) => {
    const cancelled = await So.findOneAndUpdate(
      { _id: so._id, state: { $in: ['awaiting_payment', 'payment_verifying'] } },
      {
        $set: { state: 'cancelled' },
        $push: {
          proxyLog: {
            actingStaffId: actor.employeeId,
            callNote,
            action: 'cancel_order',
            at: new Date(),
          },
        },
      },
      { session, new: true },
    );
    if (!cancelled) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'This order is no longer waiting on payment.',
      });
    }
    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'so_cancelled_by_staff',
        refCollection: 'so',
        refId: so._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        reason: callNote,
        summary: `${so.soNo} — cancelled by Sales before payment.`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'so',
        entityId: so._id as Types.ObjectId,
        field: 'state',
        oldValue: so.state,
        newValue: 'cancelled',
        reason: callNote,
        correlationId: actor.correlationId,
      },
      session,
    );
    if (so.askId) await syncEnquiryForAsk(so.askId as Types.ObjectId, session);
  });
  return { cancelled: true };
}
