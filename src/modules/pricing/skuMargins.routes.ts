import { Router, type NextFunction, type Request, type Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { numberSetting, textSetting } from '../../db/settings.js';
import { ListingModel, ProductModel, SkuMarginCellModel, SkuModel } from '../../models/index.js';
import { BUYER_TIERS, type BuyerTier } from '../../shared/enums.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { logEvent } from '../fastOrder/eventLog.js';
import { loadMargins } from './pricing.js';

/**
 * The SKU price matrix (reference LOCK-39, masters/sku-margins). Admin, Controller and Founder see it; anyone else
 * gets 404, as if it did not exist. Only an Admin drafts and submits; a DIFFERENT Admin approves or rejects (and the
 * Founder too when the setting SKU_MATRIX_FOUNDER_MAY_APPROVE is "true").
 *
 *   GET  /sku-margins                         every pack × tier: landed rate, cells, the rate in use and its source
 *   POST /sku-margins { action: 'draft', id?, skuId, buyerTier, marginPaisePerUnit, effectiveFrom }
 *   POST /sku-margins { action: 'submit', id }   draft → pending, after the tier-order check
 *   POST /sku-margins/:id/approve | /reject { reason } | /end-date { effectiveTo }
 */
export const skuMarginsRouter: Router = Router();

const TIER_LABEL: Record<BuyerTier, string> = {
  TRADER: 'Trader',
  DISTRIBUTOR: 'Distributor',
  DEALER: 'Dealer',
  RETAILER: 'Retailer',
};

/** Anyone but Admin, Controller and Founder: 404 (the route answers as if it does not exist). */
function viewersOnly(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !['ADMIN', 'CONTROLLER', 'FOUNDER'].includes(req.user.role)) {
    throw notFound('Not found.');
  }
  next();
}
skuMarginsRouter.use('/sku-margins', requireAuth, viewersOnly);

function adminOnly(req: Request) {
  if (currentUserOf(req).role !== 'ADMIN')
    throw forbidden('Only an Admin edits the SKU price matrix.');
}

const istDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/** The lowest live landed rate per pack. */
async function landedBySku() {
  const listings = await ListingModel.find({ status: 'ACTIVE' }, { skuId: 1, ratePaisePerUnit: 1 });
  const landed = new Map<string, number>();
  for (const listing of listings) {
    const key = String(listing.skuId);
    landed.set(key, Math.min(landed.get(key) ?? Infinity, listing.ratePaisePerUnit));
  }
  return landed;
}

skuMarginsRouter.get('/sku-margins', async (req, res) => {
  const [skus, cells, landed, margins, warnSharePct] = await Promise.all([
    SkuModel.find({ active: true }),
    SkuMarginCellModel.find().sort({ createdAt: -1 }),
    landedBySku(),
    loadMargins(),
    numberSetting('SKU_MATRIX_WARN_SHARE_PCT', 20),
  ]);
  const products = await ProductModel.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productName = (sku: (typeof skus)[number]) =>
    products.find((p) => p._id.equals(sku.productId))?.name ?? '';
  const sorted = [...skus].sort(
    (a, b) =>
      productName(a).localeCompare(productName(b)) || a.packLabel.localeCompare(b.packLabel),
  );
  let overridden = 0;
  const rows = sorted.map((sku) => {
    const skuCells = cells.filter((c) => c.skuId.equals(sku._id));
    if (skuCells.some((c) => c.status === 'ACTIVE')) overridden++;
    const landedPaisePerUnit = landed.get(sku.id) ?? null;
    return {
      skuId: sku.id,
      productName: productName(sku),
      packLabel: sku.packLabel,
      skuClass: sku.skuClass,
      unitsPerBox: sku.unitsPerBox,
      landedPaisePerUnit,
      tiers: BUYER_TIERS.map((buyerTier) => {
        const rate =
          landedPaisePerUnit === null ? null : margins.rateFor(sku, buyerTier, landedPaisePerUnit);
        return {
          buyerTier,
          label: TIER_LABEL[buyerTier],
          cells: skuCells
            .filter((c) => c.buyerTier === buyerTier)
            .map((c) => ({
              id: c.id,
              marginPaisePerUnit: c.marginPaisePerUnit,
              effectiveFrom: c.effectiveFrom,
              effectiveTo: c.effectiveTo ?? null,
              status: c.status,
              proposedBy: String(c.proposedBy),
              rejectReason: c.rejectReason ?? null,
            })),
          resolved:
            rate === null
              ? null
              : {
                  source: margins.sourceFor(sku, buyerTier),
                  ratePaisePerUnit: rate,
                  boxPaise: rate * sku.unitsPerBox,
                },
        };
      }),
    };
  });
  const me = currentUserOf(req);
  const overriddenSharePct = skus.length ? Math.round((overridden / skus.length) * 100) : 0;
  res.json({
    rows,
    overriddenSharePct,
    warnSharePct,
    warn: overriddenSharePct > warnSharePct,
    currentUserId: me.id,
    currentUserRole: me.role,
  });
});

const postBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('draft'),
    id: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional(),
    skuId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a pack'),
    buyerTier: z.enum(BUYER_TIERS),
    marginPaisePerUnit: z.number().int(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date it starts'),
  }),
  z.object({ action: z.literal('submit'), id: z.string().regex(/^[a-f0-9]{24}$/) }),
]);

/** The tier order on resolved rates: Trader ≤ Distributor ≤ Dealer ≤ Retailer (reference L39.6). */
async function checkTierOrder(
  sku: InstanceType<typeof SkuModel>,
  tier: BuyerTier,
  marginPaisePerUnit: number,
  effectiveFrom: Date,
) {
  const landed = (await landedBySku()).get(sku.id);
  const fail = (lower: BuyerTier, higher: BuyerTier) =>
    invalidField(
      'marginPaisePerUnit',
      `${TIER_LABEL[higher]} would be priced below ${TIER_LABEL[lower]}. Trader must stay lowest, Retailer highest.`,
    );
  if (landed === undefined) {
    // No live listing: only the SKU cells already set are compared with each other.
    const active = await SkuMarginCellModel.find({ skuId: sku._id, status: 'ACTIVE' });
    const byTier = new Map<BuyerTier, number>();
    for (const cell of active) byTier.set(cell.buyerTier, cell.marginPaisePerUnit);
    byTier.set(tier, marginPaisePerUnit);
    let previous: [BuyerTier, number] | null = null;
    for (const t of BUYER_TIERS) {
      const margin = byTier.get(t);
      if (margin === undefined) continue;
      if (previous && margin < previous[1]) throw fail(previous[0], t);
      previous = [t, margin];
    }
    return 'No live listing for this SKU — only checked against the other SKU cells already set, not against the Parent matrix.';
  }
  const margins = await loadMargins(effectiveFrom);
  let previous: [BuyerTier, number] | null = null;
  for (const t of BUYER_TIERS) {
    const rate = t === tier ? landed + marginPaisePerUnit : margins.rateFor(sku, t, landed);
    if (rate === null) continue;
    if (previous && rate < previous[1]) throw fail(previous[0], t);
    previous = [t, rate];
  }
  return null;
}

skuMarginsRouter.post('/sku-margins', async (req, res) => {
  adminOnly(req);
  const body = postBody.parse(req.body);
  const me = currentUserOf(req).id;
  if (body.action === 'draft') {
    const fields = {
      skuId: body.skuId,
      buyerTier: body.buyerTier,
      marginPaisePerUnit: body.marginPaisePerUnit,
      effectiveFrom: new Date(`${body.effectiveFrom}T00:00:00+05:30`),
    };
    if (body.id) {
      const draft = await SkuMarginCellModel.findById(body.id);
      if (!draft) throw notFound('Draft not found');
      if (draft.status !== 'DRAFT') {
        throw conflict(
          'Only a draft can be edited — submit, approve, reject and end-date each have their own action',
          'NOT_DRAFT',
        );
      }
      if (!draft.proposedBy.equals(me))
        throw forbidden('Only the Admin who started this draft can edit it');
      draft.set(fields);
      await draft.save();
      res.json({ cell: { id: draft.id, status: draft.status } });
      return;
    }
    if (!(await SkuModel.exists({ _id: body.skuId }))) throw invalidField('skuId', 'Pick a pack');
    const cell = await SkuMarginCellModel.create({ ...fields, proposedBy: me });
    res.json({ cell: { id: cell.id, status: cell.status } });
    return;
  }
  const cell = await SkuMarginCellModel.findById(body.id);
  if (!cell) throw notFound('Draft not found');
  if (cell.status !== 'DRAFT') throw conflict('This cell is not a draft', 'NOT_DRAFT');
  if (!cell.proposedBy.equals(me))
    throw forbidden('Only the Admin who started this draft can submit it');
  if (cell.marginPaisePerUnit <= 0) {
    throw invalidField(
      'marginPaisePerUnit',
      'Margin must be a whole, positive amount in paise — leave the cell blank to follow the Parent instead',
    );
  }
  if (istDay(cell.effectiveFrom) < istDay(new Date())) {
    throw invalidField('effectiveFrom', 'Changes apply from a future date only');
  }
  const sku = await SkuModel.findById(cell.skuId).orFail();
  const notice = await checkTierOrder(
    sku,
    cell.buyerTier,
    cell.marginPaisePerUnit,
    cell.effectiveFrom,
  );
  cell.status = 'PENDING';
  await cell.save();
  await logEvent({
    category: 'PRICING',
    entityType: 'SkuMarginCell',
    entityId: cell._id,
    action: 'SUBMIT',
    userId: me,
    newValue: { marginPaisePerUnit: cell.marginPaisePerUnit },
  });
  res.json({ cell: { id: cell.id, status: cell.status }, notice });
});

async function pendingCell(req: Request<{ id: string }>) {
  const me = currentUserOf(req);
  const founderMay = (await textSetting('SKU_MATRIX_FOUNDER_MAY_APPROVE', 'false')) === 'true';
  if (me.role !== 'ADMIN' && !(founderMay && me.role === 'FOUNDER')) {
    throw forbidden('Only a different Admin approves or rejects a SKU cell.');
  }
  const cell = isValidObjectId(req.params.id)
    ? await SkuMarginCellModel.findById(req.params.id)
    : null;
  if (!cell) throw notFound('Cell not found');
  if (cell.status !== 'PENDING') throw conflict('This cell is not pending approval', 'NOT_PENDING');
  if (cell.proposedBy.equals(me.id)) {
    throw forbidden(
      'The Admin who proposed this cell cannot approve or reject it — sign in as a different Admin',
    );
  }
  return { cell, me };
}

skuMarginsRouter.post('/sku-margins/:id/approve', async (req, res) => {
  const { cell, me } = await pendingCell(req);
  cell.set({ status: 'ACTIVE', decidedBy: me.id, decidedAt: new Date() });
  await cell.save();
  await logEvent({
    category: 'PRICING',
    entityType: 'SkuMarginCell',
    entityId: cell._id,
    action: 'APPROVE',
    userId: me.id,
  });
  res.json({ cell: { id: cell.id, status: cell.status } });
});

skuMarginsRouter.post('/sku-margins/:id/reject', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().default('') }).parse(req.body);
  if (!reason) throw invalidField('reason', 'A reason is required to reject');
  const { cell, me } = await pendingCell(req);
  cell.set({ status: 'REJECTED', decidedBy: me.id, decidedAt: new Date(), rejectReason: reason });
  await cell.save();
  await logEvent({
    category: 'PRICING',
    entityType: 'SkuMarginCell',
    entityId: cell._id,
    action: 'REJECT',
    userId: me.id,
    reason,
  });
  res.json({ cell: { id: cell.id, status: cell.status } });
});

skuMarginsRouter.post('/sku-margins/:id/end-date', async (req, res) => {
  adminOnly(req);
  const { effectiveTo } = z
    .object({ effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the end date') })
    .parse(req.body);
  const cell = isValidObjectId(req.params.id)
    ? await SkuMarginCellModel.findById(req.params.id)
    : null;
  if (!cell) throw notFound('Cell not found');
  if (cell.status !== 'ACTIVE')
    throw conflict('Only an active cell can be end-dated', 'NOT_ACTIVE');
  const to = new Date(`${effectiveTo}T23:59:59+05:30`);
  if (to < cell.effectiveFrom)
    throw invalidField('effectiveTo', 'The end date is before the cell starts');
  cell.effectiveTo = to;
  await cell.save();
  await logEvent({
    category: 'PRICING',
    entityType: 'SkuMarginCell',
    entityId: cell._id,
    action: 'END_DATE',
    userId: currentUserOf(req).id,
    newValue: { effectiveTo },
  });
  res.json({ cell: { id: cell.id, status: cell.status, effectiveTo: cell.effectiveTo } });
});
