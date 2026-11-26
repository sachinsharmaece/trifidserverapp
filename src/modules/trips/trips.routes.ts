import { Router, type Request } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { SalesOrderModel, TradeModel, TripModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { BOOK_WITH_MODES, TRIP_STATUSES } from '../../shared/enums.js';
import { conflict, invalidField, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { acceptedLines } from '../billing/billing.js';
import { objectId, pagingShape } from '../parties/common.js';
import type { SalesOrderDoc } from '../salesOrders/salesOrders.js';
import { runTradeAction } from '../trades/engine.js';
import { billedBoxes, destinationOf, saveTrip, whatsappText, type TripDoc } from './trips.js';

/**
 * Trips (Logistics; SRS-LOG-06…08). No buyer names or money in any answer here.
 *
 *   GET  /trips/billed                              Marg bills on no trip yet (oldest first)
 *   GET  /trips?status=PLANNED|OUT|CLOSED           trips with their bills
 *   POST /trips                                     { plannedDate, vehicleNumber, driverName, driverMobile } → 201
 *   POST /trips/:id/bills                           { version, salesOrderId, bookWith: { mode, transporter? } }
 *   POST /trips/:id/bills/:salesOrderId/remove      { version }  (while PLANNED)
 *   POST /trips/:id/check-out                       { version }  PLANNED → OUT, stores the WhatsApp text
 *   POST /trips/:id/bills/:salesOrderId/pod         engine action recordPod { version (the trade's), ref, date }
 *
 * Adding, removing and checking out change only the trip (not the trade). The POD is the engine action that
 * moves the buyer b8 → b9.
 */
export const tripsRouter: Router = Router();

const READERS = ['LOGISTICS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
/** The Controller only looks. */
const WRITERS = ['LOGISTICS', 'FOUNDER', 'ADMIN'] as const;

tripsRouter.use('/trips', requireAuth, requireRole(...READERS));

/** A billed order as the Billed list and a trip show it. */
async function billRow(order: SalesOrderDoc) {
  const accepted = await acceptedLines(order);
  return {
    salesOrderId: order.id,
    soNumber: order.number,
    tradeId: String(order.tradeId),
    margInvoiceNumber: order.margBill?.invoiceNumber ?? '',
    ewayBillNumber: order.margBill?.ewayBillNumber ?? null,
    billDate: order.margBill?.billDate ?? null,
    destination: await destinationOf(order),
    boxes: billedBoxes(order),
    items: (order.margBill?.lines ?? []).map((billed) => {
      const line = order.lines.find((item) => item.lineNo === billed.lineNo);
      const found = accepted?.lines.find((item) => item.lineNo === billed.lineNo);
      return {
        lineNo: billed.lineNo,
        productName: line?.productName ?? '',
        packLabel: line?.packLabel ?? '',
        boxes: billed.boxes,
        batch: found?.batch ?? null,
        expiryMonth: found?.expiryMonth ?? line?.expiryMonth ?? null,
      };
    }),
  };
}

/** GET /trips/billed?q=&page=&pageSize=  ->  { bills, total, page, pageSize }. `q` = SO or Marg number. */
tripsRouter.get('/trips/billed', async (req, res) => {
  const { q, page, pageSize } = z.object(pagingShape).parse(req.query);
  const words = new RegExp(escapeRegex(q), 'i');
  const orders = await SalesOrderModel.find({
    status: 'BILLED',
    ...(q ? { $or: [{ number: words }, { 'margBill.invoiceNumber': words }] } : {}),
  }).sort({ 'margBill.at': 1 });
  const onTrips = await TripModel.find(
    { 'bills.salesOrderId': { $in: orders.map((order) => order._id) } },
    { bills: 1 },
  );
  const taken = new Set(
    onTrips.flatMap((trip) => trip.bills.map((bill) => String(bill.salesOrderId))),
  );
  const free = orders.filter((order) => !taken.has(order.id));
  const pageOrders = free.slice((page - 1) * pageSize, page * pageSize);
  res.json({
    bills: await Promise.all(pageOrders.map(billRow)),
    total: free.length,
    page,
    pageSize,
  });
});

/** A trip with its bills; each bill carries its trade's version (for the POD button). */
async function tripView(trip: TripDoc) {
  const trades = await TradeModel.find(
    { _id: { $in: trip.bills.map((bill) => bill.tradeId) } },
    { version: 1 },
  );
  return {
    id: trip.id,
    code: trip.code,
    plannedDate: trip.plannedDate,
    vehicleNumber: trip.vehicleNumber,
    driverName: trip.driverName,
    driverMobile: trip.driverMobile,
    status: trip.status,
    bills: trip.bills.map((bill) => ({
      salesOrderId: String(bill.salesOrderId),
      soNumber: bill.soNumber,
      tradeId: String(bill.tradeId),
      tradeVersion: trades.find((trade) => trade._id.equals(bill.tradeId))?.version ?? null,
      margInvoiceNumber: bill.margInvoiceNumber,
      destination: bill.destination,
      boxes: bill.boxes,
      bookWith: { mode: bill.bookWith.mode, transporter: bill.bookWith.transporter ?? null },
      pod: bill.pod ? { ref: bill.pod.ref, date: bill.pod.date, at: bill.pod.at } : null,
    })),
    whatsappText: trip.whatsappText ?? null,
    checkedOutAt: trip.checkedOutAt ?? null,
    closedAt: trip.closedAt ?? null,
    createdAt: trip.createdAt,
    version: trip.version,
  };
}

const listQuery = z.object({ ...pagingShape, status: z.enum(TRIP_STATUSES).default('PLANNED') });

/** GET /trips?status=PLANNED&q=  ->  { trips, total, page, pageSize }. Planned and out: oldest first. */
tripsRouter.get('/trips', async (req, res) => {
  const { status, q, page, pageSize } = listQuery.parse(req.query);
  const filter = { status, ...(q ? { code: new RegExp(escapeRegex(q), 'i') } : {}) };
  const [total, trips] = await Promise.all([
    TripModel.countDocuments(filter),
    TripModel.find(filter)
      .sort(status === 'CLOSED' ? { closedAt: -1 } : { plannedDate: 1, code: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  res.json({ trips: await Promise.all(trips.map(tripView)), total, page, pageSize });
});

const newTrip = z.object({
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the trip date.'),
  vehicleNumber: z
    .string()
    .trim()
    .min(4, 'Enter the vehicle number.')
    .max(20)
    .transform((text) => text.toUpperCase()),
  driverName: z.string().trim().min(1, "Enter the driver's name.").max(100),
  driverMobile: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'A mobile number has 10 digits.'),
});

/** POST /trips: a new PLANNED trip. */
tripsRouter.post('/trips', requireRole(...WRITERS), async (req, res) => {
  const input = newTrip.parse(req.body);
  const trip = await TripModel.create({
    code: await nextDocumentNumber('T'),
    ...input,
    createdBy: currentUserOf(req).id,
  });
  await writeAudit(req, {
    action: 'trip.create',
    entityType: 'Trip',
    entityId: trip.id,
    after: { code: trip.code, plannedDate: trip.plannedDate, vehicleNumber: trip.vehicleNumber },
  });
  res.status(201).json({ trip: await tripView(trip) });
});

async function findTrip(id: string) {
  const trip = isValidObjectId(id) ? await TripModel.findById(id) : null;
  if (!trip) throw notFound('Trip not found.');
  return trip;
}

/** The trip's version must match what the screen loaded. */
function checkVersion(trip: TripDoc, version: number) {
  if (trip.version !== version) {
    throw conflict('Someone else changed this trip. Reload and try again.', 'STALE_TRIP');
  }
}

const version = z.number().int().min(0);
const addBill = z.object({
  version,
  salesOrderId: objectId,
  bookWith: z.object({
    mode: z.enum(BOOK_WITH_MODES),
    transporter: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((text) => text || undefined),
  }),
});

/** POST /trips/:id/bills: put a billed order on a PLANNED trip. */
tripsRouter.post('/trips/:id/bills', requireRole(...WRITERS), async (req, res) => {
  const trip = await findTrip(req.params.id);
  const input = addBill.parse(req.body);
  checkVersion(trip, input.version);
  if (trip.status !== 'PLANNED') {
    throw conflict('Bills are added only while the trip is planned.', 'TRIP_NOT_PLANNED');
  }
  if (input.bookWith.mode === 'TRANSPORT' && !input.bookWith.transporter) {
    throw invalidField('bookWith.transporter', 'Enter the transport company.');
  }
  const order = await SalesOrderModel.findById(input.salesOrderId);
  if (!order) throw notFound('Order not found.');
  if (order.status !== 'BILLED' || !order.margBill) {
    throw conflict('Only orders with a Marg bill can go on a trip.', 'NOT_BILLED');
  }
  if (await TripModel.exists({ 'bills.salesOrderId': order._id })) {
    throw conflict(`${order.number} is already on a trip.`, 'ALREADY_ON_TRIP');
  }
  const bill = {
    salesOrderId: order._id,
    tradeId: order.tradeId,
    soNumber: order.number,
    margInvoiceNumber: order.margBill.invoiceNumber,
    destination: await destinationOf(order),
    boxes: billedBoxes(order),
    bookWith: {
      mode: input.bookWith.mode,
      ...(input.bookWith.mode === 'TRANSPORT' && input.bookWith.transporter
        ? { transporter: input.bookWith.transporter }
        : {}),
    },
    addedAt: new Date(),
    addedBy: currentUserOf(req).id,
  };
  await saveTrip(
    req,
    trip,
    { bills: [...trip.bills.map((item) => item.toObject()), bill] },
    { action: 'trip.addBill', after: { code: trip.code, soNumber: order.number } },
  );
  res.json({ trip: await tripView(await TripModel.findById(trip._id).orFail()) });
});

/** POST /trips/:id/bills/:salesOrderId/remove: take a bill off a PLANNED trip. */
tripsRouter.post(
  '/trips/:id/bills/:salesOrderId/remove',
  requireRole(...WRITERS),
  async (req, res) => {
    const trip = await findTrip(req.params.id);
    checkVersion(trip, z.object({ version }).parse(req.body).version);
    if (trip.status !== 'PLANNED') {
      throw conflict('Bills are removed only while the trip is planned.', 'TRIP_NOT_PLANNED');
    }
    const id = objectId.parse(req.params.salesOrderId);
    const bill = trip.bills.find((item) => item.salesOrderId.equals(id));
    if (!bill) throw notFound('That bill is not on this trip.');
    await saveTrip(
      req,
      trip,
      { bills: trip.bills.filter((item) => item !== bill).map((item) => item.toObject()) },
      { action: 'trip.removeBill', after: { code: trip.code, soNumber: bill.soNumber } },
    );
    res.json({ trip: await tripView(await TripModel.findById(trip._id).orFail()) });
  },
);

/** POST /trips/:id/check-out: the vehicle leaves the dock. PLANNED → OUT; the WhatsApp text is stored. */
tripsRouter.post('/trips/:id/check-out', requireRole(...WRITERS), async (req, res) => {
  const trip = await findTrip(req.params.id);
  checkVersion(trip, z.object({ version }).parse(req.body).version);
  if (trip.status !== 'PLANNED') throw conflict('This trip is already out.', 'TRIP_NOT_PLANNED');
  if (trip.bills.length === 0) throw invalidField('bills', 'Add at least one bill first.');
  const text = whatsappText(trip);
  await saveTrip(
    req,
    trip,
    {
      status: 'OUT',
      whatsappText: text,
      checkedOutAt: new Date(),
      checkedOutBy: currentUserOf(req).id,
    },
    { action: 'trip.checkOut', after: { code: trip.code, bills: trip.bills.length } },
  );
  res.json({ trip: await tripView(await TripModel.findById(trip._id).orFail()) });
});

/** POST /trips/:id/bills/:salesOrderId/pod: the engine action recordPod for that bill's trade. */
tripsRouter.post(
  '/trips/:id/bills/:salesOrderId/pod',
  requireRole(...WRITERS),
  async (req: Request, res) => {
    const trip = await findTrip(req.params.id as string);
    const id = objectId.parse(req.params.salesOrderId);
    const bill = trip.bills.find((item) => item.salesOrderId.equals(id));
    if (!bill) throw notFound('That bill is not on this trip.');
    await runTradeAction(req, String(bill.tradeId), 'recordPod', req.body);
    res.json({ trip: await tripView(await TripModel.findById(trip._id).orFail()) });
  },
);
