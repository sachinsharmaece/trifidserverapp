import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { numberSetting } from '../../db/settings.js';
import {
  InspectionModel,
  PurchaseOrderModel,
  ReturnNoteModel,
  SellerModel,
  TehsilModel,
  TradeModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { RETURN_CLOSURES } from '../../shared/enums.js';
import { conflict, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { objectId, pagingShape } from '../parties/common.js';
import type { PurchaseOrderDoc } from '../purchaseOrders/purchaseOrders.js';
import { runTradeAction } from '../trades/engine.js';

/**
 * The Logistics desk (Q-WF-01, Option 3: a desk queue presses the SAME engine actions as the deal card).
 *
 *   GET  /dock?lane=COMING|ARRIVED|CHECKED     the dock's three lanes
 *   POST /dock/:purchaseOrderId/arrival        engine action recordArrival   { version, arrivedAt, boxesCounted, billWithGoods }
 *   POST /dock/:purchaseOrderId/inspection     engine action inspectLot      { version, lines[], note? }
 *   GET  /return-notes?state=OPEN|CLOSED       boxes going back to sellers
 *   POST /return-notes/:id/close               { version, how, freightPaise?, note? }
 *
 * The wall (SRS-LOG-01): no firm names and no money on the dock. A row shows the PO number, where the goods come
 * from (the seller's tehsil), the items, boxes, batch and expiry, and the transport. `version` = the trade's.
 */
export const dockRouter: Router = Router();

const DOCK_ROLES = ['LOGISTICS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const RETURN_NOTE_READERS = ['PURCHASE', 'LOGISTICS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
/** Purchase arranges the pickup; Logistics hands the boxes over. The Controller only looks. */
const RETURN_NOTE_CLOSERS = ['PURCHASE', 'LOGISTICS', 'FOUNDER', 'ADMIN'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each lane: which POs, and in what order (a queue: oldest first; checked: newest first). */
const LANES = {
  COMING: { status: ['DISPATCHED'], sort: { 'leg1.at': 1 } },
  ARRIVED: { status: ['ARRIVED'], sort: { 'arrival.arrivedAt': 1 } },
  CHECKED: { status: ['CHECKED', 'REJECTED'], sort: { inspectedAt: -1 } },
} as const;

/** Rows for the dock: no seller name, no rate, no freight amount. */
async function dockRows(purchaseOrders: PurchaseOrderDoc[]) {
  const now = Date.now();
  const transitDays = await numberSetting('TRANSIT_OVERDUE_DAYS', 4);
  const sellers = await SellerModel.find(
    { _id: { $in: purchaseOrders.map((po) => po.sellerId) } },
    { tehsilId: 1 },
  );
  const tehsils = await TehsilModel.find({
    _id: { $in: sellers.map((seller) => seller.tehsilId) },
  });
  const trades = await TradeModel.find(
    { _id: { $in: purchaseOrders.map((po) => po.tradeId) } },
    { version: 1 },
  );
  const inspections = await InspectionModel.find({
    _id: { $in: purchaseOrders.map((po) => po.latestInspectionId).filter(Boolean) },
  });
  const returnNotes = await ReturnNoteModel.find({
    purchaseOrderId: { $in: purchaseOrders.map((po) => po._id) },
  });

  return purchaseOrders.map((po) => {
    const seller = sellers.find((item) => item._id.equals(po.sellerId));
    const tehsil = seller ? tehsils.find((item) => item._id.equals(seller.tehsilId)) : undefined;
    const inspection = po.latestInspectionId
      ? inspections.find((item) => item._id.equals(po.latestInspectionId))
      : undefined;
    const leg1 = po.leg1;
    const daysOnRoad = leg1 ? Math.floor((now - leg1.at.getTime()) / DAY_MS) : null;
    return {
      purchaseOrderId: po.id,
      number: po.number,
      status: po.status,
      tradeId: String(po.tradeId),
      tradeVersion: trades.find((trade) => trade._id.equals(po.tradeId))?.version ?? null,
      from: tehsil ? `${tehsil.name}, ${tehsil.district}` : '',
      boxes: po.lines.reduce((sum, line) => sum + line.boxes, 0),
      lines: po.lines.map((line) => {
        const declared = leg1?.lines.find((item) => item.lineNo === line.lineNo);
        return {
          lineNo: line.lineNo,
          productName: line.productName,
          packLabel: line.packLabel,
          unitsPerBox: line.unitsPerBox,
          boxes: line.boxes,
          expiryMonth: line.expiryMonth,
          batchNumber: line.batchNumber ?? null,
          batchDeclared: declared?.batchDeclared ?? null,
          expiryDeclared: declared?.expiryDeclared ?? null,
          shortExpiryAgreed: declared?.shortExpiryAgreed ?? false,
        };
      }),
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
            dispatchedOn: leg1.dispatchedOn,
            at: leg1.at,
          }
        : null,
      daysOnRoad,
      // More than TRANSIT_OVERDUE_DAYS on the road and not arrived: shown red (SRS-LOG-01).
      transitOverdue: po.status === 'DISPATCHED' && daysOnRoad !== null && daysOnRoad > transitDays,
      arrival: po.arrival
        ? {
            arrivedAt: po.arrival.arrivedAt,
            boxesCounted: po.arrival.boxesCounted,
            billWithGoods: po.arrival.billWithGoods,
          }
        : null,
      inspectBy: po.inspectBy ?? null,
      inspectionOverdue:
        po.status === 'ARRIVED' && Boolean(po.inspectBy) && po.inspectBy!.getTime() < now,
      result: inspection
        ? {
            outcome: inspection.outcome,
            acceptedBoxes: inspection.acceptedBoxes,
            savedAt: inspection.savedAt,
            note: inspection.note ?? null,
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
            })),
          }
        : null,
      returnNotes: returnNotes
        .filter((note) => note.purchaseOrderId.equals(po._id))
        .map((note) => ({ number: note.number, type: note.type, boxes: note.boxes })),
    };
  });
}

dockRouter.use('/dock', requireAuth, requireRole(...DOCK_ROLES));

const laneQuery = z.object({
  ...pagingShape,
  lane: z.enum(['COMING', 'ARRIVED', 'CHECKED']).default('COMING'),
});

/** GET /dock?lane=COMING&q=&page=&pageSize=  ->  { rows, total, page, pageSize }. `q` = PO number. */
dockRouter.get('/dock', async (req, res) => {
  const { lane, q, page, pageSize } = laneQuery.parse(req.query);
  const filter = {
    status: { $in: LANES[lane].status },
    ...(q ? { number: new RegExp(escapeRegex(q), 'i') } : {}),
  };
  const [total, purchaseOrders] = await Promise.all([
    PurchaseOrderModel.countDocuments(filter),
    PurchaseOrderModel.find(filter)
      .sort(LANES[lane].sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  res.json({ rows: await dockRows(purchaseOrders), total, page, pageSize });
});

async function findPurchaseOrder(id: string) {
  const po = isValidObjectId(id) ? await PurchaseOrderModel.findById(id) : null;
  if (!po) throw notFound('Purchase order not found.');
  return po;
}

/** Press the engine action for this PO's trade, then answer with the PO's new dock row. */
async function press(
  req: Parameters<typeof runTradeAction>[0],
  id: string,
  action: 'recordArrival' | 'inspectLot',
) {
  const po = await findPurchaseOrder(id);
  await runTradeAction(req, String(po.tradeId), action, req.body);
  const [row] = await dockRows([await PurchaseOrderModel.findById(po._id).orFail()]);
  return { row };
}

dockRouter.post('/dock/:id/arrival', async (req, res) => {
  res.json(await press(req, req.params.id, 'recordArrival'));
});

dockRouter.post('/dock/:id/inspection', async (req, res) => {
  res.json(await press(req, req.params.id, 'inspectLot'));
});

// --- Return notes -----------------------------------------------------------------------------------------

dockRouter.use('/return-notes', requireAuth, requireRole(...RETURN_NOTE_READERS));

const notesQuery = z.object({ ...pagingShape, state: z.enum(['OPEN', 'CLOSED']).default('OPEN') });

/** GET /return-notes?state=OPEN&q=  ->  { returnNotes, total, page, pageSize }. Open ones: due soonest first. */
dockRouter.get('/return-notes', async (req, res) => {
  const { state, q, page, pageSize } = notesQuery.parse(req.query);
  const words = new RegExp(escapeRegex(q), 'i');
  const pos = q ? await PurchaseOrderModel.find({ number: words }, { _id: 1 }) : [];
  const filter: Record<string, unknown> = {
    state,
    ...(q
      ? { $or: [{ number: words }, { purchaseOrderId: { $in: pos.map((po) => po._id) } }] }
      : {}),
  };
  const [total, notes] = await Promise.all([
    ReturnNoteModel.countDocuments(filter),
    ReturnNoteModel.find(filter)
      .sort(state === 'OPEN' ? { dueAt: 1 } : { 'closure.at': -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const numbers = await PurchaseOrderModel.find(
    { _id: { $in: notes.map((note) => note.purchaseOrderId) } },
    { number: 1 },
  );
  const now = Date.now();
  res.json({
    returnNotes: notes.map((note) => ({
      id: note.id,
      number: note.number,
      type: note.type,
      item: note.item,
      boxes: note.boxes,
      reason: note.reason,
      dueAt: note.dueAt,
      overdue: note.state === 'OPEN' && note.dueAt.getTime() < now,
      state: note.state,
      purchaseOrder: {
        id: String(note.purchaseOrderId),
        number: numbers.find((po) => po._id.equals(note.purchaseOrderId))?.number ?? '',
      },
      closure: note.closure
        ? {
            how: note.closure.how,
            freightPaise: note.closure.freightPaise ?? null,
            note: note.closure.note ?? null,
            at: note.closure.at,
          }
        : null,
      createdAt: note.createdAt,
      version: note.version,
    })),
    total,
    page,
    pageSize,
  });
});

const closeBody = z.object({
  version: z.number().int().min(0),
  how: z.enum(RETURN_CLOSURES),
  freightPaise: z.number().int().min(1).max(100_000_000_000).optional(),
  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((text) => text || undefined),
});

/** POST /return-notes/:id/close: the boxes went back (or were disposed of). Never deleted, never written off. */
dockRouter.post(
  '/return-notes/:id/close',
  requireRole(...RETURN_NOTE_CLOSERS),
  async (req, res) => {
    const id = objectId.parse(req.params.id);
    const input = closeBody.parse(req.body);
    const note = await ReturnNoteModel.findById(id);
    if (!note) throw notFound('Return note not found.');
    if (note.state !== 'OPEN')
      throw conflict('This return note is already closed.', 'ALREADY_CLOSED');
    if (note.version !== input.version) {
      throw conflict(
        'Someone else changed this return note. Reload and try again.',
        'STALE_RETURN_NOTE',
      );
    }
    const closure = {
      how: input.how,
      ...(input.freightPaise ? { freightPaise: input.freightPaise } : {}),
      ...(input.note ? { note: input.note } : {}),
      by: currentUserOf(req).id,
      at: new Date(),
    };
    const result = await ReturnNoteModel.updateOne(
      { _id: note._id, version: note.version, state: 'OPEN' },
      { $set: { state: 'CLOSED', closure }, $inc: { version: 1 } },
      { runValidators: true },
    );
    if (result.matchedCount !== 1) {
      throw conflict(
        'Someone else changed this return note. Reload and try again.',
        'STALE_RETURN_NOTE',
      );
    }
    await writeAudit(req, {
      action: 'returnNote.close',
      entityType: 'ReturnNote',
      entityId: note.id,
      before: { state: 'OPEN' },
      after: { state: 'CLOSED', how: input.how, freightPaise: input.freightPaise ?? null },
    });
    res.json({ returnNote: { id: note.id, number: note.number, state: 'CLOSED' } });
  },
);
