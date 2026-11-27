import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  BuyerModel,
  EventLogModel,
  SellerModel,
  SkuModel,
  StockPurchaseOrderModel,
  UserModel,
} from '../../models/index.js';
import { EVENT_CATEGORIES } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { canUseListings } from '../parties/permissions.js';
import { autoConfirmBody, turnOff, turnOn } from './autoConfirm.js';
import { checkStockPo, recordStockArrival, stockArrivalInput, stockCheckInput } from './house.js';

/**
 * Fast order (reference FAST-ORDER LOCK-42), part A and B:
 *
 *   POST /listings/:id/auto-confirm   { action: 'on', boxes } | { action: 'off', reason, note? }  ->  { listing }
 *   GET  /stock-dock?lane=COMING|ARRIVED|CHECKED                   Stock POs at the Indore dock
 *   POST /stock-dock/:id/arrival      { boxesCounted, photoFileId? }      ISSUED → ARRIVED (Logistics)
 *   POST /stock-dock/:id/check        { lines: [{ lineNo, acceptedBoxes, expiryFound }] }  → CHECKED, into TriFid Stock
 *   GET  /event-log?category=&entityId=&partyId=      the event log (listing and credit lines), newest first
 */
export const fastOrderRouter: Router = Router();

fastOrderRouter.post(
  '/listings/:id/auto-confirm',
  requireAuth,
  canUseListings,
  async (req, res) => {
    const id = String(req.params.id);
    if (!isValidObjectId(id)) throw notFound('Listing not found.');
    const body = autoConfirmBody.parse(req.body);
    const me = currentUserOf(req).id;
    const listing =
      body.action === 'on'
        ? await turnOn(id, body.boxes, me)
        : await turnOff(id, body.reason, body.note, me);
    res.json({
      listing: {
        id: listing.id,
        autoConfirm: listing.autoConfirm,
        autoBoxesSet: listing.autoBoxesSet ?? 0,
        autoBoxesLeft: listing.autoBoxesLeft ?? 0,
        autoOffReason: listing.autoOffReason ?? null,
      },
    });
  },
);

const DOCK_ROLES = ['LOGISTICS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const DOCK_WRITERS = ['LOGISTICS', 'FOUNDER', 'ADMIN'] as const;
fastOrderRouter.use('/stock-dock', requireAuth, requireRole(...DOCK_ROLES));

const LANE_STATUS = { COMING: 'ISSUED', ARRIVED: 'ARRIVED', CHECKED: 'CHECKED' } as const;

fastOrderRouter.get('/stock-dock', async (req, res) => {
  const { lane } = z
    .object({ lane: z.enum(['COMING', 'ARRIVED', 'CHECKED']).default('COMING') })
    .parse(req.query);
  const pos = await StockPurchaseOrderModel.find({ status: LANE_STATUS[lane] })
    .sort({ [lane === 'CHECKED' ? 'checkedAt' : 'dispatchDueDate']: lane === 'CHECKED' ? -1 : 1 })
    .limit(100);
  const skus = await SkuModel.find({
    _id: { $in: pos.flatMap((po) => po.lines.map((l) => l.skuId)) },
  });
  res.json({
    rows: pos.map((po) => ({
      id: po.id,
      number: po.number,
      status: po.status,
      // Stock POs come from an outside seller into TriFid Stock; Logistics sees the seller's name as on any lot.
      seller: po.sellerSnapshot.firmName,
      dispatchDueDate: po.dispatchDueDate,
      boxes: po.lines.reduce((sum, line) => sum + line.boxes, 0),
      arrival: po.arrival ? { at: po.arrival.at, boxesCounted: po.arrival.boxesCounted } : null,
      lines: po.lines.map((line) => ({
        lineNo: line.lineNo,
        productName: line.productName,
        packLabel: line.packLabel,
        unitsPerBox: line.unitsPerBox,
        boxes: line.boxes,
        acceptedBoxes: line.acceptedBoxes ?? null,
        expiryFound: line.expiryFound ?? null,
        skuClass: skus.find((sku) => sku._id.equals(line.skuId))?.skuClass ?? null,
      })),
      checkedAt: po.checkedAt ?? null,
    })),
  });
});

fastOrderRouter.post('/stock-dock/:id/arrival', requireRole(...DOCK_WRITERS), async (req, res) => {
  const po = await recordStockArrival(
    req,
    String(req.params.id),
    stockArrivalInput.parse(req.body),
  );
  res.json({ id: po.id, status: po.status });
});

fastOrderRouter.post('/stock-dock/:id/check', requireRole(...DOCK_WRITERS), async (req, res) => {
  const po = await checkStockPo(req, String(req.params.id), stockCheckInput.parse(req.body));
  res.json({ id: po.id, status: po.status });
});

const eventQuery = z.object({
  category: z.enum(EVENT_CATEGORIES).optional(),
  entityId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  partyId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

fastOrderRouter.get(
  '/event-log',
  requireAuth,
  requireRole('PURCHASE', 'ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'),
  async (req, res) => {
    const query = eventQuery.parse(req.query);
    // Purchase sees only listing lines (credit is the buyer side).
    const category = currentUserOf(req).role === 'PURCHASE' ? 'LISTING' : query.category;
    const events = await EventLogModel.find({
      ...(category ? { category } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.partyId ? { partyId: query.partyId } : {}),
    })
      .sort({ at: -1 })
      .limit(query.limit);
    const users = await UserModel.find(
      { _id: { $in: events.flatMap((e) => (e.userId ? [e.userId] : [])) } },
      { name: 1 },
    );
    const partyIds = events.flatMap((e) => (e.partyId ? [e.partyId] : []));
    const [buyers, sellers] = await Promise.all([
      BuyerModel.find({ _id: { $in: partyIds } }, { firmName: 1 }),
      SellerModel.find({ _id: { $in: partyIds } }, { firmName: 1 }),
    ]);
    const partyName = (id: unknown) =>
      id
        ? ([...buyers, ...sellers].find((p) => p._id.equals(id as string))?.firmName ?? null)
        : null;
    res.json({
      events: events.map((event) => ({
        id: String(event._id),
        at: event.at,
        category: event.category,
        entityType: event.entityType,
        entityId: String(event.entityId),
        partyId: event.partyId ? String(event.partyId) : null,
        party: partyName(event.partyId),
        action: event.action,
        by: event.userId
          ? (users.find((user) => user._id.equals(event.userId))?.name ?? '')
          : 'System',
        oldValue: (event.oldValue as unknown) ?? null,
        newValue: (event.newValue as unknown) ?? null,
        reason: event.reason ?? null,
      })),
    });
  },
);
