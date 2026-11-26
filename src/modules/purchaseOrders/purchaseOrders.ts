import { numberSetting } from '../../db/settings.js';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  ListingModel,
  PurchaseOrderModel,
  type SalesOrderModel,
  SellerModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { Role } from '../../shared/enums.js';
import { requireRole } from '../auth/requireRole.js';
import type { CommandContext } from '../trades/commands.js';

/**
 * Purchase orders (PO-26-0001). Raised ONLY by the trade engine at Gate A (`confirmPayment`, when the buyer has
 * paid his order in full), inside the engine's transaction. One PO per sales order, one seller (A-10).
 *
 * The seller side of the wall: a PO names the seller and his rate, never the buyer or our selling rate. Purchase,
 * Accounts (seller identity on PO records) and the supervisors read POs; Sales and Logistics do not (yet).
 */

export type PurchaseOrderDoc = InstanceType<typeof PurchaseOrderModel>;
type OrderDoc = InstanceType<typeof SalesOrderModel>;

export const PO_READER_ROLES: readonly Role[] = [
  'PURCHASE',
  'ACCOUNTS',
  'CONTROLLER',
  'FOUNDER',
  'ADMIN',
];
export const canReadPurchaseOrders = requireRole(...PO_READER_ROLES);

const DEFAULT_DISPATCH_HOURS = 8;

/** Gate A passed: raise the PO to the seller from the paid sales order's frozen line. */
export async function raisePurchaseOrder(
  { req, trade, userId, now, session }: CommandContext,
  order: OrderDoc,
) {
  const seller = await SellerModel.findById(order.sellerId).session(session).orFail();
  const listing = trade.listingId
    ? await ListingModel.findById(trade.listingId).session(session)
    : null;
  const line = order.lines[0];
  if (!line) throw new Error('The sales order has no line');
  const lineTotalPaise = line.landedPaisePerUnit * line.unitsPerBox * line.boxes;
  const hours = await numberSetting('SLA_S3_HOURS', DEFAULT_DISPATCH_HOURS);

  const [po] = await PurchaseOrderModel.create(
    [
      {
        number: await nextDocumentNumber('PO', { session, at: now }),
        salesOrderId: order._id,
        tradeId: trade._id,
        sellerId: seller._id,
        sellerSnapshot: {
          number: seller.number,
          firmName: seller.firmName,
          ...(seller.gstin ? { gstin: seller.gstin } : {}),
        },
        status: 'RAISED',
        lines: [
          {
            lineNo: 1,
            skuId: line.skuId,
            productName: line.productName,
            packLabel: line.packLabel,
            unitsPerBox: line.unitsPerBox,
            boxes: line.boxes,
            expiryMonth: line.expiryMonth,
            ...(line.batchNumber ? { batchNumber: line.batchNumber } : {}),
            landedPaisePerUnit: line.landedPaisePerUnit,
            ...(listing
              ? {
                  rateType: listing.rateType,
                  ...(listing.rateType === 'EX'
                    ? {
                        exRatePaisePerUnit: listing.exRatePaisePerUnit,
                        colPaisePerBox: listing.colPaisePerBox,
                      }
                    : {}),
                }
              : {}),
            lineTotalPaise,
          },
        ],
        totalPaise: lineTotalPaise,
        dispatchDueAt: new Date(now.getTime() + hours * 60 * 60 * 1000),
        createdBy: userId,
      },
    ],
    { session },
  );
  if (!po) throw new Error('The purchase order was not created');
  await writeAudit(req, {
    action: 'purchaseOrder.raise',
    entityType: 'PurchaseOrder',
    entityId: po.id,
    after: { number: po.number, salesOrder: order.number, totalPaise: po.totalPaise },
    session,
  });
  return po;
}

/** One row of the Purchase orders list. */
export function purchaseOrderRow(po: PurchaseOrderDoc) {
  const line = po.lines[0];
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    seller: { number: po.sellerSnapshot.number, firmName: po.sellerSnapshot.firmName },
    item: line ? `${line.productName} · ${line.packLabel} × ${line.boxes} boxes` : '',
    totalPaise: po.totalPaise,
    dispatchDueAt: po.dispatchDueAt,
    createdAt: po.createdAt,
  };
}

/** The full PO. The same for every reader: it holds nothing from the buyer side. */
export function purchaseOrderView(po: PurchaseOrderDoc) {
  return {
    ...purchaseOrderRow(po),
    tradeId: String(po.tradeId),
    seller: {
      id: String(po.sellerId),
      number: po.sellerSnapshot.number,
      firmName: po.sellerSnapshot.firmName,
      gstin: po.sellerSnapshot.gstin ?? null,
    },
    lines: po.lines.map((line) => ({
      lineNo: line.lineNo,
      productName: line.productName,
      packLabel: line.packLabel,
      unitsPerBox: line.unitsPerBox,
      boxes: line.boxes,
      expiryMonth: line.expiryMonth,
      batchNumber: line.batchNumber ?? null,
      landedPaisePerUnit: line.landedPaisePerUnit,
      rateType: line.rateType ?? null,
      exRatePaisePerUnit: line.exRatePaisePerUnit ?? null,
      colPaisePerBox: line.colPaisePerBox ?? null,
      lineTotalPaise: line.lineTotalPaise,
    })),
  };
}
