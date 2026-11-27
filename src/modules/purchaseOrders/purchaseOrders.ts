import { numberSetting } from '../../db/settings.js';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  InspectionModel,
  ListingModel,
  PurchaseOrderModel,
  ReturnNoteModel,
  type SalesOrderModel,
  SellerModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { Role } from '../../shared/enums.js';
import { requireRole } from '../auth/requireRole.js';
import type { CommandContext } from '../trades/commands.js';
import { payoutOfPo } from '../payouts/payouts.js';

/**
 * Purchase orders (PO-26-0001). Raised ONLY by the trade engine at Gate A (`confirmPayment`, when the buyer has
 * paid his order in full), inside the engine's transaction. One PO per sales order, one seller (A-10).
 *
 * The seller side of the wall: a PO names the seller and his rate, never the buyer or our selling rate. Purchase,
 * Accounts (seller identity on PO records) and the supervisors read POs; Sales does not. Logistics works from the
 * Dock screen, which shows the PO without firm names or money (modules/dock/dock.routes.ts).
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
    /** When the seller was paid (the bank proof was typed), else null. */
    paidAt: po.paidAt ?? null,
    createdAt: po.createdAt,
  };
}

/** Leg 1, the seller's bill, the arrival and the dock's result: for the deal card and the PO page. */
function dockFacts(po: PurchaseOrderDoc) {
  const leg1 = po.leg1;
  return {
    leg1: leg1
      ? {
          mode: leg1.mode,
          transporter: leg1.transporter ?? null,
          lrNumber: leg1.lrNumber ?? null,
          lrDate: leg1.lrDate ?? null,
          busDetails: leg1.busDetails ?? null,
          driverName: leg1.driverName ?? null,
          driverMobile: leg1.driverMobile ?? null,
          note: leg1.note ?? null,
          freightTerms: leg1.freightTerms,
          freightPaise: leg1.freightPaise ?? null,
          dispatchedOn: leg1.dispatchedOn,
          lines: leg1.lines.map((line) => ({
            lineNo: line.lineNo,
            batchDeclared: line.batchDeclared ?? null,
            expiryDeclared: line.expiryDeclared ?? null,
            shortExpiryAgreed: line.shortExpiryAgreed,
          })),
          at: leg1.at,
        }
      : null,
    sellerBill: po.sellerBill
      ? {
          number: po.sellerBill.number,
          amountPaise: po.sellerBill.amountPaise,
          billDate: po.sellerBill.billDate,
          at: po.sellerBill.at,
        }
      : null,
    arrival: po.arrival
      ? {
          arrivedAt: po.arrival.arrivedAt,
          boxesCounted: po.arrival.boxesCounted,
          billWithGoods: po.arrival.billWithGoods,
        }
      : null,
    inspectBy: po.inspectBy ?? null,
    outcome: po.outcome ?? null,
    acceptedBoxes: po.acceptedBoxes ?? null,
    acceptedValuePaise: po.acceptedValuePaise ?? null,
    inspectedAt: po.inspectedAt ?? null,
  };
}

/** The PO on the deal card's seller side: its lines (for the dispatch and dock forms) and the dock facts. */
export function purchaseOrderSummary(po: PurchaseOrderDoc) {
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    totalPaise: po.totalPaise,
    dispatchDueAt: po.dispatchDueAt,
    paidAt: po.paidAt ?? null,
    lines: po.lines.map((line) => ({
      lineNo: line.lineNo,
      productName: line.productName,
      packLabel: line.packLabel,
      unitsPerBox: line.unitsPerBox,
      boxes: line.boxes,
      expiryMonth: line.expiryMonth,
      batchNumber: line.batchNumber ?? null,
    })),
    ...dockFacts(po),
  };
}

/** The full PO. The same for every reader: it holds nothing from the buyer side. */
export async function purchaseOrderView(po: PurchaseOrderDoc) {
  const inspection = po.latestInspectionId
    ? await InspectionModel.findById(po.latestInspectionId)
    : null;
  const returnNotes = await ReturnNoteModel.find({ purchaseOrderId: po._id }).sort({ number: 1 });
  return {
    ...purchaseOrderRow(po),
    ...dockFacts(po),
    /** Where the seller's payment is: in a batch, released, or paid with its UTR (Build 5). */
    payout: await payoutOfPo(po),
    inspection: inspection
      ? {
          outcome: inspection.outcome,
          boxesCounted: inspection.boxesCounted,
          note: inspection.note ?? null,
          savedAt: inspection.savedAt,
          lines: inspection.lines.map((line) => ({
            lineNo: line.lineNo,
            boxesOnPo: line.boxesOnPo,
            boxesShort: line.boxesShort,
            boxesDamaged: line.boxesDamaged,
            boxesLeaking: line.boxesLeaking,
            boxesAccepted: line.boxesAccepted,
            boxesExcess: line.boxesExcess,
            batchFound: line.batchFound ?? null,
            expiryFound: line.expiryFound ?? null,
            batchDiffers: line.batchDiffers,
            expiryDiffers: line.expiryDiffers,
            belowShelfLife: line.belowShelfLife,
            shortExpiryAgreed: line.shortExpiryAgreed,
          })),
        }
      : null,
    returnNotes: returnNotes.map((note) => ({
      id: note.id,
      number: note.number,
      type: note.type,
      boxes: note.boxes,
      reason: note.reason,
      state: note.state,
      dueAt: note.dueAt,
    })),
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
