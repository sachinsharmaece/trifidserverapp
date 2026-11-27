import { numberSetting } from '../../db/settings.js';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { BuyerModel, CompanyModel, HsnCodeModel, ProductModel, ReceiptModel, SalesOrderModel, SellerModel, SkuModel, } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict } from '../../shared/errors.js';
import { HOME_STATE_CODE, splitGst } from '../../shared/money.js';
import { margBillView } from '../billing/billing.js';
import { complaintsOf } from '../complaints/complaints.js';
import { refundsOf } from '../dock/dock.js';
import { paymentsOf } from '../payments/payments.js';
import { deliveryOf } from '../trips/trips.js';
import { requireRole } from '../auth/requireRole.js';
/** Who may read sales orders: the buyer side (Sales), Accounts (who will confirm payments), and supervisors. */
export const ORDER_READER_ROLES = [
    'SALES',
    'ACCOUNTS',
    'CONTROLLER',
    'FOUNDER',
    'ADMIN',
];
export const canReadSalesOrders = requireRole(...ORDER_READER_ROLES);
/** Who also sees the seller and his rate on an order: the supervisors (never Sales or Accounts). */
const SEES_SELLER = ['CONTROLLER', 'FOUNDER', 'ADMIN'];
const DEFAULT_PAYMENT_WINDOW_HOURS = 24;
/**
 * The buyer said yes (`buyerYes`): raise his sales order from the trade's fixed offer and the seller's answer.
 * Everything on the order is copied now, so later changes to the buyer, pack or margins do not change it.
 */
export async function raiseSalesOrder({ req, trade, userId, now, session }) {
    const answer = trade.sellerAnswer;
    const rate = trade.offer?.buyerRatePaisePerUnit ?? null;
    if (!answer || !trade.offer || rate === null || !trade.sellerId || !trade.skuId) {
        throw conflict('Send the offer to the buyer first.', 'NO_OFFER');
    }
    const buyer = await BuyerModel.findById(trade.buyerId).orFail();
    if (!buyer.active)
        throw conflict('This buyer is turned off.', 'BUYER_INACTIVE');
    const sku = await SkuModel.findById(trade.skuId).orFail();
    const product = await ProductModel.findById(sku.productId).orFail();
    const hsn = await HsnCodeModel.findById(product.hsnCodeId).orFail();
    const company = await CompanyModel.findOne();
    const interState = buyer.stateCode !== (company?.stateCode ?? HOME_STATE_CODE);
    // Rates include tax: box value = rate × units per box; line total = box value × boxes; GST worked back out.
    const boxValuePaise = rate * answer.unitsPerBox;
    const lineTotalPaise = boxValuePaise * answer.boxes;
    const hours = await numberSetting('PAYMENT_WINDOW_HOURS', DEFAULT_PAYMENT_WINDOW_HOURS);
    const [order] = await SalesOrderModel.create([
        {
            number: await nextDocumentNumber('SO', { session, at: now }),
            buyerId: buyer._id,
            buyerSnapshot: {
                number: buyer.number,
                firmName: buyer.firmName,
                ...(buyer.gstin ? { gstin: buyer.gstin } : {}),
                stateCode: buyer.stateCode,
                deliveryLocation: buyer.deliveryLocation,
                rateTier: trade.offer.tier,
                classified: Boolean(buyer.classifiedAt),
            },
            tradeId: trade._id,
            sellerId: trade.sellerId,
            status: 'AWAITING_PAYMENT',
            interState,
            lines: [
                {
                    lineNo: 1,
                    tradeId: trade._id,
                    ...(trade.listingId ? { listingId: trade.listingId } : {}),
                    skuId: sku._id,
                    productName: product.name,
                    packLabel: sku.packLabel,
                    unitsPerBox: answer.unitsPerBox,
                    hsnCode: hsn.code,
                    skuClass: sku.skuClass,
                    rateTier: trade.offer.tier,
                    boxes: answer.boxes,
                    expiryMonth: answer.expiryMonth,
                    ...(answer.batchNumber ? { batchNumber: answer.batchNumber } : {}),
                    landedPaisePerUnit: answer.landedPaisePerUnit,
                    buyerRatePaisePerUnit: rate,
                    boxValuePaise,
                    lineTotalPaise,
                    taxBp: product.taxBp,
                },
            ],
            totalPaise: lineTotalPaise,
            gst: splitGst(lineTotalPaise, product.taxBp, interState),
            paymentDueAt: new Date(now.getTime() + hours * 60 * 60 * 1000),
            paidPaise: 0,
            createdBy: userId,
        },
    ], { session });
    if (!order)
        throw new Error('The sales order was not created');
    await writeAudit(req, {
        action: 'salesOrder.raise',
        entityType: 'SalesOrder',
        entityId: order.id,
        after: { number: order.number, status: order.status, totalPaise: order.totalPaise },
        session,
    });
    return order;
}
/**
 * The buyer dropped the order before paying (`leakAfterOrder`): the order is cancelled with the reason.
 * Refunds come with payments; until then an order with money received cannot be cancelled here.
 */
export async function cancelSalesOrder({ req, trade, userId, now, session }, reason) {
    const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
    const waiting = await ReceiptModel.countDocuments({
        salesOrderId: order._id,
        status: 'LOGGED',
    }).session(session);
    if (waiting > 0) {
        throw conflict('A payment entered for this order is waiting for Accounts: ask them to confirm or reject it first.', 'PAYMENT_WAITING');
    }
    if (order.status !== 'AWAITING_PAYMENT' || order.paidPaise > 0) {
        throw conflict('Money was received for this order: refunds are not built yet.', 'ORDER_HAS_PAYMENT');
    }
    const result = await SalesOrderModel.updateOne({ _id: order._id, version: order.version }, {
        $set: {
            status: 'CANCELLED',
            cancel: {
                at: now,
                byUserId: userId,
                reasonCodeId: reason.reasonCodeId,
                reasonLabel: reason.reasonLabel,
                ...(reason.note ? { note: reason.note } : {}),
            },
        },
        $inc: { version: 1 },
    }, { session, runValidators: true });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
    }
    await writeAudit(req, {
        action: 'salesOrder.cancel',
        entityType: 'SalesOrder',
        entityId: order.id,
        before: { status: order.status },
        after: { status: 'CANCELLED', reason: reason.reasonLabel },
        session,
    });
    return order;
}
/** b9 → b10: the buyer has the goods (engine action `confirmDelivery`). The order becomes DELIVERED. */
export async function markDelivered({ req, trade, now, session }) {
    const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
    const result = await SalesOrderModel.updateOne({ _id: order._id, version: order.version }, { $set: { status: 'DELIVERED', deliveredAt: now }, $inc: { version: 1 } }, { session, runValidators: true });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
    }
    await writeAudit(req, {
        action: 'salesOrder.deliver',
        entityType: 'SalesOrder',
        entityId: order.id,
        before: { status: order.status },
        after: { status: 'DELIVERED' },
        session,
    });
}
/** One row of the Sales orders list. */
export function salesOrderRow(order) {
    const line = order.lines[0];
    return {
        id: order.id,
        number: order.number,
        status: order.status,
        buyer: { number: order.buyerSnapshot.number, firmName: order.buyerSnapshot.firmName },
        item: line ? `${line.productName} · ${line.packLabel} × ${line.boxes} boxes` : '',
        totalPaise: order.totalPaise,
        paymentDueAt: order.paymentDueAt,
        createdAt: order.createdAt,
    };
}
/**
 * The full order as `role` may see it. Sales and Accounts get the buyer side only; the supervisors also get the
 * seller and his rate per line. The margin is never sent (it is the difference, and stays on the wall).
 */
export async function salesOrderView(order, role) {
    const seesSeller = SEES_SELLER.includes(role);
    const seller = seesSeller ? await SellerModel.findById(order.sellerId) : null;
    return {
        id: order.id,
        number: order.number,
        status: order.status,
        tradeId: String(order.tradeId),
        buyer: {
            id: String(order.buyerId),
            number: order.buyerSnapshot.number,
            firmName: order.buyerSnapshot.firmName,
            gstin: order.buyerSnapshot.gstin ?? null,
            stateCode: order.buyerSnapshot.stateCode,
            deliveryLocation: order.buyerSnapshot.deliveryLocation,
            rateTier: order.buyerSnapshot.rateTier,
            classified: order.buyerSnapshot.classified,
        },
        interState: order.interState,
        lines: order.lines.map((line) => ({
            lineNo: line.lineNo,
            productName: line.productName,
            packLabel: line.packLabel,
            unitsPerBox: line.unitsPerBox,
            hsnCode: line.hsnCode,
            boxes: line.boxes,
            expiryMonth: line.expiryMonth,
            batchNumber: line.batchNumber ?? null,
            buyerRatePaisePerUnit: line.buyerRatePaisePerUnit,
            boxValuePaise: line.boxValuePaise,
            lineTotalPaise: line.lineTotalPaise,
            taxBp: line.taxBp,
            ...(seesSeller ? { landedPaisePerUnit: line.landedPaisePerUnit } : {}),
        })),
        totalPaise: order.totalPaise,
        gst: {
            taxablePaise: order.gst.taxablePaise,
            cgstPaise: order.gst.cgstPaise,
            sgstPaise: order.gst.sgstPaise,
            igstPaise: order.gst.igstPaise,
        },
        paymentDueAt: order.paymentDueAt,
        paidPaise: order.paidPaise,
        paidAt: order.paidAt ?? null,
        payments: (await paymentsOf(order._id)).map(({ enteredById: _hidden, ...payment }) => payment),
        // Money owed back to the buyer after the dock check (paid later, with payouts).
        refunds: await refundsOf(order._id),
        complaints: await complaintsOf({ salesOrderId: order._id }),
        // Build 4: the Marg bill, the trip and delivery.
        margBill: margBillView(order),
        delivery: await deliveryOf(order),
        cancel: order.cancel
            ? {
                at: order.cancel.at,
                reasonLabel: order.cancel.reasonLabel,
                note: order.cancel.note ?? null,
            }
            : null,
        createdAt: order.createdAt,
        ...(seesSeller
            ? {
                seller: seller
                    ? { id: seller.id, number: seller.number, firmName: seller.firmName }
                    : null,
            }
            : {}),
    };
}
//# sourceMappingURL=salesOrders.js.map