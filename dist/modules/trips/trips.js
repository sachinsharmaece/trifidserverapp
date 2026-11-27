import { z } from 'zod';
import { BuyerModel, SalesOrderModel, TehsilModel, TripModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, invalidField } from '../../shared/errors.js';
import { istDate } from '../payments/payments.js';
/** Where an order goes, without the buyer's name: "Mhow bus stand (Mhow, Indore)". */
export async function destinationOf(order) {
    const buyer = await BuyerModel.findById(order.buyerId, { tehsilId: 1 });
    const tehsil = buyer ? await TehsilModel.findById(buyer.tehsilId) : null;
    const place = order.buyerSnapshot.deliveryLocation;
    return tehsil ? `${place} (${tehsil.name}, ${tehsil.district})` : place;
}
/** Boxes billed on an order's Marg bill. */
export const billedBoxes = (order) => (order.margBill?.lines ?? []).reduce((sum, line) => sum + line.boxes, 0);
/** The WhatsApp notice for the driver and the transporters, stored at check-out (Q-LOG-07: sent by hand). */
export function whatsappText(trip) {
    const lines = trip.bills.map((bill, index) => {
        const via = bill.bookWith.mode === 'TRANSPORT'
            ? `book with ${bill.bookWith.transporter ?? ''}`
            : bill.bookWith.mode === 'BUS'
                ? 'bus parcel'
                : 'deliver direct';
        return `${index + 1}. ${bill.margInvoiceNumber} · ${bill.boxes} boxes → ${bill.destination} · ${via}`;
    });
    return [
        `Trip ${trip.code} · ${trip.plannedDate}`,
        `Vehicle ${trip.vehicleNumber} · ${trip.driverName} (${trip.driverMobile})`,
        ...lines,
    ].join('\n');
}
/** Saves a trip change with its version check and audit line (outside the engine: a trip is not a trade). */
export async function saveTrip(req, trip, set, audit, session) {
    const result = await TripModel.updateOne({ _id: trip._id, version: trip.version }, { $set: set, $inc: { version: 1 } }, { runValidators: true, ...(session ? { session } : {}) });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this trip. Reload and try again.', 'STALE_TRIP');
    }
    await writeAudit(req, {
        action: audit.action,
        entityType: 'Trip',
        entityId: trip.id,
        after: audit.after,
        ...(session ? { session } : {}),
    });
}
export const podInput = z.object({
    ref: z.string().trim().min(1, 'Enter the LR or receipt number.').max(80),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.'),
});
/**
 * The proof of dispatch for this trade's bill (engine action `recordPod`). The bill must be on a trip that is OUT.
 * The trip closes by itself when every bill has a POD. The order becomes DISPATCHED.
 */
export async function recordPod(ctx, input) {
    const { req, trade, userId, now, session } = ctx;
    const order = await SalesOrderModel.findById(trade.salesOrderId).session(session).orFail();
    const trip = await TripModel.findOne({ 'bills.salesOrderId': order._id }).session(session);
    const bill = trip?.bills.find((item) => item.salesOrderId.equals(order._id));
    if (!trip || !bill)
        throw conflict('Put this bill on a trip first.', 'NOT_ON_TRIP');
    if (trip.status !== 'OUT') {
        throw conflict(`Check trip ${trip.code} out of the dock first.`, 'TRIP_NOT_OUT');
    }
    if (bill.pod)
        throw conflict('The POD for this bill is already recorded.', 'WRONG_STAGE');
    if (input.date > istDate(now))
        throw invalidField('date', 'The POD date cannot be in the future.');
    const pod = { ref: input.ref, date: input.date, by: userId, at: now };
    const bills = trip.bills.map((item) => item.salesOrderId.equals(order._id) ? { ...item.toObject(), pod } : item.toObject());
    const allDone = bills.every((item) => Boolean(item.pod));
    await saveTrip(req, trip, { bills, ...(allDone ? { status: 'CLOSED', closedAt: now } : {}) }, { action: 'trip.pod', after: { soNumber: order.number, ref: input.ref, closed: allDone } }, session);
    const result = await SalesOrderModel.updateOne({ _id: order._id, version: order.version }, { $set: { status: 'DISPATCHED', dispatchedAt: now }, $inc: { version: 1 } }, { session, runValidators: true });
    if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this order. Reload and try again.', 'STALE_ORDER');
    }
    await writeAudit(req, {
        action: 'salesOrder.dispatch',
        entityType: 'SalesOrder',
        entityId: order.id,
        before: { status: order.status },
        after: { status: 'DISPATCHED', trip: trip.code, pod: input.ref },
        session,
    });
    const via = bill.bookWith.mode === 'TRANSPORT'
        ? `${bill.bookWith.transporter ?? 'transport'}, LR ${input.ref}`
        : bill.bookWith.mode === 'BUS'
            ? `bus parcel, receipt ${input.ref}`
            : `delivered direct, ${input.ref}`;
    return { tripCode: trip.code, via, closed: allDone };
}
/** The trip a sales order is on, for the deal card and order page (buyer side: movement only). */
export async function deliveryOf(order) {
    const trip = await TripModel.findOne({ 'bills.salesOrderId': order._id });
    const bill = trip?.bills.find((item) => item.salesOrderId.equals(order._id));
    return {
        trip: trip && bill
            ? {
                code: trip.code,
                status: trip.status,
                vehicleNumber: trip.vehicleNumber,
                bookWith: { mode: bill.bookWith.mode, transporter: bill.bookWith.transporter ?? null },
                pod: bill.pod ? { ref: bill.pod.ref, date: bill.pod.date } : null,
            }
            : null,
        dispatchedAt: order.dispatchedAt ?? null,
        deliveredAt: order.deliveredAt ?? null,
    };
}
//# sourceMappingURL=trips.js.map