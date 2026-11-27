import type { Request } from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  ProductModel,
  SellerModel,
  SkuModel,
  StockPurchaseOrderModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import type { PurchaseOrderDoc } from './purchaseOrders.js';

/**
 * Stock POs (reference-copy branch; reference FAST-ORDER LOCK-42 L42.12). Purchase (or a supervisor) raises one
 * against an outside seller with no sales order behind it; it waits PENDING_APPROVAL until the Controller, Founder or
 * Admin — never the person who raised it — approves it, and then it is ISSUED.
 */
export const canRaiseStockPo = requireRole('ADMIN', 'PURCHASE', 'CONTROLLER', 'FOUNDER');
export const canApproveStockPo = requireRole('ADMIN', 'CONTROLLER', 'FOUNDER');

type StockPoDoc = InstanceType<typeof StockPurchaseOrderModel>;

const objectId = z.string().refine(isValidObjectId, 'Select a valid item');

const createBody = z.object({
  type: z.literal('STOCK', 'Trade POs are raised automatically when the buyer has paid.'),
  sellerId: objectId,
  dispatchDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dispatch due date is required'),
  lines: z
    .array(
      z.object({
        skuId: objectId,
        /** ₹ per unit, as typed (the reference sends rupees; paise are worked out here). */
        sellerNetRupeesPerUnit: z.number().positive('Enter the rate').max(10_000_000),
        boxes: z.number().int().positive('Enter the boxes').max(1_000_000),
      }),
    )
    .min(1, 'At least one line is required'),
});

/** Is a trade PO payable? A reason for every gate that fails (reference lib/payable.ts). */
export function payableOf(po: PurchaseOrderDoc) {
  const gates = {
    arrived: Boolean(po.arrival),
    inspected: Boolean(po.latestInspectionId),
    billed: Boolean(po.sellerBill),
  };
  const reasons: string[] = [];
  if (!gates.arrived) reasons.push('goods not at Indore');
  if (!gates.inspected) reasons.push('not inspected');
  if (!gates.billed) reasons.push('no seller bill');
  if (po.hold) reasons.push(po.hold.reason ? `on hold: ${po.hold.reason}` : 'on hold');
  if (po.paidAt) reasons.push('already paid');
  return { payable: reasons.length === 0, gates, reasons };
}

/** What the browser gets for a Stock PO, in the same shape as a trade PO row where they overlap. */
export function stockPoView(po: StockPoDoc) {
  const line = po.lines[0];
  return {
    id: po.id,
    number: po.number,
    type: 'STOCK' as const,
    // Approved once it leaves PENDING_APPROVAL; `status` then follows it through the dock (ARRIVED, CHECKED).
    approvalStatus:
      po.status === 'PENDING_APPROVAL' ? ('PENDING_APPROVAL' as const) : ('ISSUED' as const),
    status: po.status,
    seller: { number: po.sellerSnapshot.number, firmName: po.sellerSnapshot.firmName },
    item: line ? `${line.productName} · ${line.packLabel} × ${line.boxes} boxes` : '',
    lines: po.lines.map((l) => ({
      lineNo: l.lineNo,
      productName: l.productName,
      packLabel: l.packLabel,
      unitsPerBox: l.unitsPerBox,
      boxes: l.boxes,
      landedPaisePerUnit: l.landedPaisePerUnit,
      lineTotalPaise: l.lineTotalPaise,
    })),
    totalPaise: po.totalPaise,
    dispatchDueDate: po.dispatchDueDate,
    salesOrderNumber: null,
    payable: null,
    approvedAt: po.approvedAt ?? null,
    createdAt: po.createdAt,
  };
}

export async function createStockPo(req: Request) {
  const body = createBody.parse(req.body);
  const me = currentUserOf(req);
  const seller = await SellerModel.findById(body.sellerId);
  if (!seller || !seller.active) throw invalidField('sellerId', 'Select a seller');
  const skus = await SkuModel.find({ _id: { $in: body.lines.map((l) => l.skuId) } });
  const products = await ProductModel.find({ _id: { $in: skus.map((s) => s.productId) } });
  const lines = body.lines.map((input, index) => {
    const sku = skus.find((s) => s.id === input.skuId);
    if (!sku) throw invalidField('lines', 'Select a valid pack on every line');
    const rate = Math.round(input.sellerNetRupeesPerUnit * 100);
    return {
      lineNo: index + 1,
      skuId: sku._id,
      productName: products.find((p) => p._id.equals(sku.productId))?.name ?? '',
      packLabel: sku.packLabel,
      unitsPerBox: sku.unitsPerBox,
      boxes: input.boxes,
      landedPaisePerUnit: rate,
      lineTotalPaise: rate * sku.unitsPerBox * input.boxes,
    };
  });
  const totalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

  return mongoose.connection.transaction(async (session) => {
    const number = await nextDocumentNumber('PO', { session });
    const [po] = await StockPurchaseOrderModel.create(
      [
        {
          number,
          status: 'PENDING_APPROVAL',
          sellerId: seller._id,
          sellerSnapshot: { number: seller.number, firmName: seller.firmName },
          lines,
          totalPaise,
          dispatchDueDate: body.dispatchDueDate,
          createdBy: me.id,
        },
      ],
      { session },
    );
    if (!po) throw new Error('Stock PO was not created.');
    await writeAudit(req, {
      action: 'stockPo.create',
      entityType: 'StockPurchaseOrder',
      entityId: po.id,
      before: {},
      after: { number, sellerId: String(seller._id), totalPaise },
      session,
    });
    return po;
  });
}

export async function approveStockPo(req: Request, id: string) {
  const me = currentUserOf(req);
  const po = isValidObjectId(id) ? await StockPurchaseOrderModel.findById(id) : null;
  if (!po) throw notFound('Purchase order not found.');
  if (po.status !== 'PENDING_APPROVAL') throw conflict('This Stock PO is already issued.');
  if (String(po.createdBy) === me.id) {
    throw forbidden('The person who raised a Stock PO cannot approve it.');
  }
  po.set({ status: 'ISSUED', approvedBy: me.id, approvedAt: new Date() });
  await po.save();
  await writeAudit(req, {
    action: 'stockPo.approve',
    entityType: 'StockPurchaseOrder',
    entityId: po.id,
    before: { status: 'PENDING_APPROVAL' },
    after: { status: 'ISSUED' },
  });
  return po;
}
