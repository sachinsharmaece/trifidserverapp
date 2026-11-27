import type { Request } from 'express';
import mongoose, { type ClientSession, isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { nextPartyNumber } from '../../db/documentNumbers.js';
import { numberSetting } from '../../db/settings.js';
import { ListingModel, SellerModel, StockPurchaseOrderModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { ExpiryBand } from '../../shared/enums.js';
import { conflict, invalidField, notFound } from '../../shared/errors.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { dedupeKeyOf } from '../listings/rates.js';
import { monthsFromNow } from '../trades/stages.js';
import { logEvent } from './eventLog.js';

/**
 * TriFid Stock (reference lib/stock/house.ts, FAST-ORDER LOCK-42 Part B). The one house seller: stock TriFid has
 * bought with a Stock PO and checked at the Indore dock. Its listings are always auto-confirm, and an order from
 * it skips the seller side (no PO, no dispatch, no dock check): paid → To be billed.
 *
 * A Stock PO goes through the dock like any lot: ISSUED → ARRIVED (Logistics counts the boxes) → CHECKED (boxes
 * accepted per line, the expiry found). The accepted boxes are added to TriFid Stock's listing for that pack (one
 * is made if there is none), at the Stock PO's rate.
 */

export const HOUSE_NAME = 'TriFid Stock';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LISTING_LIFE_DAYS = 45;

/** The house seller, made the first time it is needed. */
export async function houseSeller(session?: ClientSession | null) {
  const found = await SellerModel.findOne({ isHouse: true }).session(session ?? null);
  if (found) return found;
  const [created] = await SellerModel.create(
    [
      {
        number: await nextPartyNumber('SEL', session ? { session } : {}),
        firmName: HOUSE_NAME,
        dispatchCutoff: '17:00',
        tier: 'TRUSTED',
        isHouse: true,
      },
    ],
    { session: session ?? null },
  );
  return created!;
}

/** Is this seller TriFid Stock? */
export async function isHouseSeller(sellerId: unknown, session?: ClientSession | null) {
  if (!sellerId) return false;
  return Boolean(
    await SellerModel.exists({ _id: sellerId, isHouse: true }).session(session ?? null),
  );
}

/** The expiry band an exact month falls in (the same three bands every listing uses). */
function bandFor(expiryMonth: string, now: Date): ExpiryBand {
  const left = monthsFromNow(expiryMonth, now);
  if (left >= 12) return 'M12_PLUS';
  if (left >= 9) return 'M9_TO_12';
  return 'M6_TO_9';
}

async function findStockPo(id: string, session?: ClientSession) {
  const po = isValidObjectId(id)
    ? await StockPurchaseOrderModel.findById(id).session(session ?? null)
    : null;
  if (!po) throw notFound('Stock PO not found.');
  return po;
}

export const stockArrivalInput = z.object({
  boxesCounted: z.number().int().min(0, 'Enter the boxes counted').max(1_000_000),
  photoFileId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
});

/** The Stock PO's goods reached the Indore dock: Logistics counts the boxes. ISSUED → ARRIVED. */
export async function recordStockArrival(
  req: Request,
  id: string,
  input: z.output<typeof stockArrivalInput>,
) {
  const po = await findStockPo(id);
  if (po.status !== 'ISSUED') {
    throw conflict(
      po.status === 'PENDING_APPROVAL'
        ? 'This Stock PO is not approved yet.'
        : 'The arrival of this Stock PO is already recorded.',
      'STOCK_PO_STAGE',
    );
  }
  const me = currentUserOf(req);
  po.set({
    status: 'ARRIVED',
    arrival: {
      at: new Date(),
      boxesCounted: input.boxesCounted,
      ...(input.photoFileId ? { photoFileId: input.photoFileId } : {}),
      by: me.id,
    },
  });
  await po.save();
  await writeAudit(req, {
    action: 'stockPurchaseOrder.arrival',
    entityType: 'StockPurchaseOrder',
    entityId: po.id,
    after: { status: 'ARRIVED', boxesCounted: input.boxesCounted },
  });
  return po;
}

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the expiry month');

export const stockCheckInput = z.object({
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        acceptedBoxes: z.number().int().min(0).max(1_000_000),
        expiryFound: month,
      }),
    )
    .min(1, 'Check every line'),
});

/**
 * The dock check of a Stock PO: boxes accepted per line (never more than ordered) and the expiry month found.
 * ARRIVED → CHECKED, and the accepted boxes go into TriFid Stock (one live listing per pack, always auto-confirm).
 */
export async function checkStockPo(
  req: Request,
  id: string,
  input: z.output<typeof stockCheckInput>,
) {
  const me = currentUserOf(req);
  const now = new Date();
  const lifeDays = await numberSetting('LISTING_LIFE_DAYS', DEFAULT_LISTING_LIFE_DAYS);
  return mongoose.connection.transaction(async (session) => {
    const po = await findStockPo(id, session);
    if (po.status !== 'ARRIVED') {
      throw conflict(
        po.status === 'CHECKED'
          ? 'This Stock PO is already checked.'
          : 'Record the arrival of this Stock PO first.',
        'STOCK_PO_STAGE',
      );
    }
    const house = await houseSeller(session);
    for (const line of po.lines) {
      const typed = input.lines.find((item) => item.lineNo === line.lineNo);
      if (!typed) throw invalidField('lines', `Check line ${line.lineNo} too.`);
      if (typed.acceptedBoxes > line.boxes) {
        throw invalidField('lines', `Line ${line.lineNo}: only ${line.boxes} boxes were ordered.`);
      }
      if (monthsFromNow(typed.expiryFound, now) < 0) {
        throw invalidField('lines', `Line ${line.lineNo}: that expiry month has already passed.`);
      }
      line.set({
        acceptedBoxes: typed.acceptedBoxes,
        rejectedBoxes: line.boxes - typed.acceptedBoxes,
        expiryFound: typed.expiryFound,
      });
      if (typed.acceptedBoxes === 0) continue;

      // One live TriFid Stock listing per pack; the latest landed rate wins (as the reference).
      const key = {
        sellerId: house.id,
        skuId: String(line.skuId),
        rateType: 'FOR' as const,
        ratePaisePerUnit: line.landedPaisePerUnit,
        expiryBand: bandFor(typed.expiryFound, now),
        moqBoxes: 1,
        provenance: 'OWN_STOCK' as const,
      };
      const existing = await ListingModel.findOne({
        sellerId: house._id,
        skuId: line.skuId,
        status: 'ACTIVE',
      }).session(session);
      if (existing) {
        const quantity = existing.quantityBoxes + typed.acceptedBoxes;
        existing.set({
          ratePaisePerUnit: line.landedPaisePerUnit,
          expiryBand: key.expiryBand,
          expiryMonth: typed.expiryFound,
          quantityBoxes: quantity,
          autoConfirm: true,
          autoBoxesSet: quantity,
          autoBoxesLeft: (existing.autoBoxesLeft ?? 0) + typed.acceptedBoxes,
          expiresAt: new Date(now.getTime() + lifeDays * DAY_MS),
          dedupeKey: dedupeKeyOf(key),
        });
        await existing.save({ session });
        line.set({ houseListingId: existing._id });
        await logEvent(
          {
            category: 'LISTING',
            entityType: 'Listing',
            entityId: existing._id,
            partyId: house._id,
            action: 'AUTO_RESTORED',
            newValue: { boxes: typed.acceptedBoxes, source: po.number },
          },
          session,
        );
      } else {
        const [created] = await ListingModel.create(
          [
            {
              ...key,
              unitsPerBoxSnapshot: line.unitsPerBox,
              quantityBoxes: typed.acceptedBoxes,
              expiryMonth: typed.expiryFound,
              expiresAt: new Date(now.getTime() + lifeDays * DAY_MS),
              dedupeKey: dedupeKeyOf(key),
              autoConfirm: true,
              autoBoxesSet: typed.acceptedBoxes,
              autoBoxesLeft: typed.acceptedBoxes,
              autoOnAt: now,
              createdBy: me.id,
            },
          ],
          { session },
        );
        line.set({ houseListingId: created!._id });
        await logEvent(
          {
            category: 'LISTING',
            entityType: 'Listing',
            entityId: created!._id,
            partyId: house._id,
            action: 'AUTO_ON',
            newValue: { boxes: typed.acceptedBoxes, source: po.number },
          },
          session,
        );
      }
    }
    po.set({ status: 'CHECKED', checkedAt: now, checkedBy: me.id });
    await po.save({ session });
    await writeAudit(req, {
      action: 'stockPurchaseOrder.check',
      entityType: 'StockPurchaseOrder',
      entityId: po.id,
      after: {
        status: 'CHECKED',
        lines: po.lines.map((line) => ({
          lineNo: line.lineNo,
          acceptedBoxes: line.acceptedBoxes,
          expiryFound: line.expiryFound,
        })),
      },
      session,
    });
    return po;
  });
}
