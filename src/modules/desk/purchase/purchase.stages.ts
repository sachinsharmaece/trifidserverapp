import type { Types } from 'mongoose';
import { So } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Po } from '../../../models/Po.js';
import { PoLine } from '../../../models/PoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Seller } from '../../../models/Seller.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { StockHold } from '../../../models/StockHold.js';
import { AppError } from '../../../shared/errors.js';
import { appendProxyLog } from '../../../shared/proxyLog.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { recordMovement } from '../../movement/movement.service.js';

/**
 * Purchase desk stages between Confirmations and Dispatch:
 *   Confirmations → Stock (seller holds the confirmed stock until the buyer pays)
 *                 → PO (released on payment) → Billed (seller has invoiced) → Dispatch.
 *
 * The PO still exists only after the buyer's payment is posted (Q4, INV-01), so Stock comes
 * before PO. Every response below follows the desk's wall (BR-067/BR-069): seller identity
 * and goods only — no buyer identity and no rupee figure.
 */

export const DEFAULT_STOCK_HOLD_HOURS = 24; // BR-032 — matches the buyer's payment window.
const HOUR_MS = 60 * 60 * 1000;

interface StaffActor {
  employeeId: string;
  correlationId: string;
}

async function firmBySellerId(sellerIds: Types.ObjectId[]): Promise<Map<string, string>> {
  if (sellerIds.length === 0) return new Map();
  const sellers = await Seller.find({ _id: { $in: sellerIds } });
  const counterparties = await Counterparty.find({
    _id: { $in: sellers.map((s) => s.counterpartyId) },
  });
  const firmByCounterpartyId = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '—']),
  );
  return new Map(
    sellers.map((s) => [
      (s._id as Types.ObjectId).toString(),
      firmByCounterpartyId.get((s.counterpartyId as Types.ObjectId).toString()) ?? '—',
    ]),
  );
}

/** Product, pack and box count for a set of lines keyed by their owner's id. */
async function goodsByOwner(
  lines: Array<{ owner: string; skuId: Types.ObjectId; boxes: number }>,
): Promise<Map<string, { brand: string; packLabel: string; boxes: number }>> {
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  return new Map(
    lines.map((line) => {
      const sku = skuById.get(line.skuId.toString());
      const product = sku
        ? productById.get((sku.productId as Types.ObjectId).toString())
        : undefined;
      return [
        line.owner,
        { brand: product?.brand ?? '—', packLabel: sku?.packLabel ?? '—', boxes: line.boxes },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// Stock — confirmed orders still waiting on the buyer's payment.
// ---------------------------------------------------------------------------

/** The seller is holding the stock from the moment the order exists; `lapsed` once the hold runs out. */
export type StockHoldStatus = 'holding' | 'lapsed';

export interface StockQueueItem {
  soId: string;
  soNo: string;
  sellerId: string;
  sellerFirm: string;
  brand: string;
  packLabel: string;
  boxes: number;
  /** The seller's own rate for these goods — never the buyer's rate or order total (the wall). */
  sellerRatePaise: number | null;
  /** When the buyer's payment window closes — the order cancels after this if unpaid. */
  payDeadline: string;
  hold: StockHoldStatus;
  /** Null on an order raised before holds opened automatically (it holds to the pay deadline). */
  holdHours: number | null;
  holdUntil: string;
  holdConfirmedAt: string | null;
  hoursLeft: number;
}

/** GET /staff/purchase/stock — orders awaiting payment, with the seller's hold on each. */
export async function getStockQueue(sellerId?: string): Promise<StockQueueItem[]> {
  const now = Date.now();
  const sos = await So.find({
    state: { $in: ['awaiting_payment', 'payment_verifying'] },
    ...(sellerId ? { sellerId } : {}),
  }).sort({
    payDeadline: 1,
  });
  if (sos.length === 0) return [];
  const lines = await SoLine.find({ soId: { $in: sos.map((s) => s._id) } });
  const goods = await goodsByOwner(
    lines.map((l) => ({
      owner: (l.soId as Types.ObjectId).toString(),
      skuId: l.skuId as Types.ObjectId,
      boxes: l.boxes,
    })),
  );
  const sellerRateBySo = new Map(
    lines.map((l) => [(l.soId as Types.ObjectId).toString(), l.sellerNetPaise as number]),
  );
  const holds = await StockHold.find({ soId: { $in: sos.map((s) => s._id) } });
  const holdBySo = new Map(holds.map((h) => [(h.soId as Types.ObjectId).toString(), h]));
  const firms = await firmBySellerId(sos.map((s) => s.sellerId as Types.ObjectId));

  return sos.map((so) => {
    const soId = (so._id as Types.ObjectId).toString();
    const sellerId = (so.sellerId as Types.ObjectId).toString();
    // An order raised before holds opened automatically has no row: it counts as held for the
    // buyer's payment window, the same as a new one.
    const stored = holdBySo.get(soId);
    const hold = stored ?? {
      holdHours: null,
      holdUntil: so.payDeadline,
      confirmedAt: null,
    };
    const status: StockHoldStatus = hold.holdUntil.getTime() < now ? 'lapsed' : 'holding';
    const g = goods.get(soId) ?? { brand: '—', packLabel: '—', boxes: 0 };
    return {
      soId,
      soNo: so.soNo,
      sellerId,
      sellerFirm: firms.get(sellerId) ?? '—',
      ...g,
      sellerRatePaise: sellerRateBySo.get(soId) ?? null,
      payDeadline: so.payDeadline.toISOString(),
      hold: status,
      holdHours: hold.holdHours,
      holdUntil: hold.holdUntil.toISOString(),
      holdConfirmedAt: hold.confirmedAt ? hold.confirmedAt.toISOString() : null,
      hoursLeft: Math.round(((hold.holdUntil.getTime() - now) / HOUR_MS) * 10) / 10,
    };
  });
}

async function loadUnpaidOrder(soId: string) {
  assertValidObjectId(soId, 'soId');
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (so.state !== 'awaiting_payment' && so.state !== 'payment_verifying') {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn:
        'This order is no longer waiting on the buyer’s payment, so there is nothing to hold.',
    });
  }
  return so;
}

/** Stock: Purchase asks the seller to hold the stock for N hours (default 24) until the buyer pays. */
export async function requestStockHold(
  soId: string,
  input: { holdHours?: number },
  actor: StaffActor,
  callNote: string,
): Promise<{ holdUntil: string }> {
  const so = await loadUnpaidOrder(soId);
  const holdHours = input.holdHours ?? DEFAULT_STOCK_HOLD_HOURS;
  const now = new Date();
  const holdUntil = new Date(now.getTime() + holdHours * HOUR_MS);
  await StockHold.findOneAndUpdate(
    { soId: so._id },
    {
      $set: {
        sellerId: so.sellerId,
        holdHours,
        requestedAt: now,
        requestedBy: actor.employeeId,
        holdUntil,
        // Asking again starts a new hold: the seller has to say yes to this one.
        confirmedAt: null,
        confirmedBy: null,
      },
      $push: {
        proxyLog: { actingStaffId: actor.employeeId, callNote, action: 'ask_hold', at: now },
      },
    },
    { upsert: true, new: true },
  );
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'stock_hold',
    entityId: so._id as Types.ObjectId,
    field: 'requested',
    newValue: { holdHours },
    correlationId: actor.correlationId,
  });
  return { holdUntil: holdUntil.toISOString() };
}

/**
 * Stock: Purchase changes how long the seller holds the stock (the hold itself opens with the
 * order). The new length runs from now, so it can lengthen or shorten what is left. The hold
 * stays confirmed; a hold that had already run out is held again by this.
 */
export async function adjustStockHold(
  soId: string,
  input: { holdHours: number },
  actor: StaffActor,
  callNote: string,
): Promise<{ holdUntil: string }> {
  const so = await loadUnpaidOrder(soId);
  const now = new Date();
  const holdUntil = new Date(now.getTime() + input.holdHours * HOUR_MS);
  const before = await StockHold.findOne({ soId: so._id });
  await StockHold.findOneAndUpdate(
    { soId: so._id },
    {
      $set: { holdHours: input.holdHours, holdUntil, confirmedAt: before?.confirmedAt ?? now },
      $setOnInsert: { sellerId: so.sellerId, requestedAt: now, source: 'auto' },
      $push: {
        proxyLog: { actingStaffId: actor.employeeId, callNote, action: 'adjust_hold', at: now },
      },
    },
    { upsert: true, new: true },
  );
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'stock_hold',
    entityId: so._id as Types.ObjectId,
    field: 'holdHours',
    oldValue: before?.holdHours ?? null,
    newValue: input.holdHours,
    reason: callNote,
    correlationId: actor.correlationId,
  });
  return { holdUntil: holdUntil.toISOString() };
}

/** Stock: the seller has said he is holding it. */
export async function confirmStockHold(
  soId: string,
  actor: StaffActor,
  callNote: string,
): Promise<{ confirmed: true }> {
  const so = await loadUnpaidOrder(soId);
  const hold = await StockHold.findOne({ soId: so._id });
  if (!hold) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Ask the seller to hold the stock first.',
    });
  }
  if (hold.holdUntil.getTime() < Date.now()) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That hold has run out — ask the seller to hold it again.',
    });
  }
  hold.confirmedAt = new Date();
  hold.confirmedBy = actor.employeeId as unknown as Types.ObjectId;
  await hold.save();
  await appendProxyLog(StockHold, (hold._id as Types.ObjectId).toString(), {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'confirm_hold',
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'stock_hold',
    entityId: so._id as Types.ObjectId,
    field: 'confirmed',
    correlationId: actor.correlationId,
  });
  return { confirmed: true };
}

// ---------------------------------------------------------------------------
// PO → Billed → Dispatch — released POs, by how far the seller has got.
// ---------------------------------------------------------------------------

export interface PoStageItem {
  poId: string;
  poNo: string;
  sellerId: string;
  sellerFirm: string;
  brand: string;
  packLabel: string;
  boxes: number;
  releasedAt: string;
  dispatchDueDate: string;
  hoursLeft: number;
  invoiceNo: string | null;
  invoiceDate: string | null;
  ewayNo: string | null;
}

async function describePos(pos: Array<InstanceType<typeof Po>>): Promise<PoStageItem[]> {
  if (pos.length === 0) return [];
  const now = Date.now();
  const lines = await PoLine.find({ poId: { $in: pos.map((p) => p._id) } });
  const goods = await goodsByOwner(
    lines.map((l) => ({
      owner: (l.poId as Types.ObjectId).toString(),
      skuId: l.skuId as Types.ObjectId,
      boxes: l.boxes,
    })),
  );
  const firms = await firmBySellerId(pos.map((p) => p.sellerId as Types.ObjectId));
  return pos.map((po) => {
    const poId = (po._id as Types.ObjectId).toString();
    const sellerId = (po.sellerId as Types.ObjectId).toString();
    return {
      poId,
      poNo: po.poNo,
      sellerId,
      sellerFirm: firms.get(sellerId) ?? '—',
      ...(goods.get(poId) ?? { brand: '—', packLabel: '—', boxes: 0 }),
      releasedAt: (po as unknown as { createdAt: Date }).createdAt.toISOString(),
      dispatchDueDate: po.dispatchDueDate.toISOString(),
      hoursLeft: Math.round(((po.dispatchDueDate.getTime() - now) / HOUR_MS) * 10) / 10,
      invoiceNo: po.sellerInvoiceNo ?? null,
      invoiceDate: po.sellerInvoiceDate ? po.sellerInvoiceDate.toISOString() : null,
      ewayNo: po.sellerEwayNo ?? null,
    };
  });
}

/** GET /staff/purchase/pos — released, the seller has not yet invoiced the goods. */
export async function getPoQueue(sellerId?: string): Promise<PoStageItem[]> {
  const pos = await Po.find({
    state: 'released',
    failed: false,
    sellerInvoiceNo: null,
    ...(sellerId ? { sellerId } : {}),
  }).sort({
    dispatchDueDate: 1,
  });
  return describePos(pos);
}

/** GET /staff/purchase/billed — invoiced by the seller, not yet handed to Dispatch. */
export async function getBilledQueue(sellerId?: string): Promise<PoStageItem[]> {
  const pos = await Po.find({
    state: 'released',
    ...(sellerId ? { sellerId } : {}),
    failed: false,
    sellerInvoiceNo: { $ne: null },
    handedToDispatchAt: null,
  }).sort({ dispatchDueDate: 1 });
  return describePos(pos);
}

async function loadReleasedPo(poId: string) {
  assertValidObjectId(poId, 'poId');
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
  if (po.state !== 'released' || po.failed) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: 'This PO has already left the seller or is no longer active.',
    });
  }
  return po;
}

/** PO → Billed: the seller has invoiced the goods; record his invoice and e-way bill. */
export async function recordSellerInvoice(
  poId: string,
  input: { invoiceNo: string; date: Date; ewayNo: string },
  actor: StaffActor,
  callNote: string,
): Promise<{ recorded: true }> {
  const po = await loadReleasedPo(poId);
  if (po.sellerInvoiceNo) {
    throw new AppError({
      code: 'DOCUMENT_ALREADY_BILLED',
      messageEn: 'An invoice is already recorded for this PO.',
    });
  }
  po.sellerInvoiceNo = input.invoiceNo;
  po.sellerInvoiceDate = input.date;
  po.sellerEwayNo = input.ewayNo;
  po.sellerInvoiceRecordedAt = new Date();
  await po.save();
  await appendProxyLog(Po, poId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'record_seller_invoice',
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'po',
    entityId: po._id as Types.ObjectId,
    field: 'seller_invoice',
    newValue: { invoiceNo: input.invoiceNo, ewayNo: input.ewayNo },
    correlationId: actor.correlationId,
  });
  return { recorded: true };
}

/**
 * Dispatch → At Indore: the seller has sent the goods (leg 1), reported by him on a call. It is
 * the same `recordMovement` Logistics uses, so its guards apply (the PO must be released). That
 * the goods then *arrive* is the dock's own act (goods-in) — nothing here records it.
 */
export async function recordSellerDispatch(
  poId: string,
  input: Omit<Parameters<typeof recordMovement>[1], 'leg'>,
  actor: StaffActor,
  callNote: string,
): Promise<{ movementId: string }> {
  const po = await loadReleasedPo(poId);
  const result = await recordMovement(
    (po.chainId as Types.ObjectId).toString(),
    { ...input, leg: 1 },
    actor,
  );
  await appendProxyLog(Po, poId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'seller_dispatched',
  });
  return result;
}

/** Billed → Dispatch: hand the invoiced PO over to the dispatch chase. */
export async function handToDispatch(
  poId: string,
  actor: StaffActor,
  callNote: string,
): Promise<{ handedOver: true }> {
  const po = await loadReleasedPo(poId);
  if (!po.sellerInvoiceNo) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: 'Record the seller’s invoice and e-way bill before handing it to Dispatch.',
    });
  }
  if (po.handedToDispatchAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This PO is already with Dispatch.',
    });
  }
  po.handedToDispatchAt = new Date();
  await po.save();
  await appendProxyLog(Po, poId, {
    actingStaffId: actor.employeeId,
    callNote,
    action: 'hand_to_dispatch',
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'po',
    entityId: po._id as Types.ObjectId,
    field: 'handed_to_dispatch',
    correlationId: actor.correlationId,
  });
  return { handedOver: true };
}
