import { Router } from 'express';
import { z } from 'zod';
import { MarginCellModel, UserModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { BUYER_TIERS, SKU_CLASSES, type BuyerTier, type SkuClass } from '../../shared/enums.js';
import { badRequest, conflict } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireStepUp } from '../auth/stepUp.js';
import { canEditMasters, canSeeMargins } from './permissions.js';

/**
 * The margin matrix (the "Parent" matrix, ARCH §B3.2): TriFid's margin in % for each pack class and buyer tier.
 * A cell is never edited or deleted. A change is a NEW cell that starts now or later, and pricing uses the latest
 * cell that has already started (SRS-MST-04).
 */
export const marginCellsRouter: Router = Router();

const MARGIN_CELL_EXISTS = 'MARGIN_CELL_EXISTS';

const createBody = z.object({
  skuClass: z.enum(SKU_CLASSES),
  buyerTier: z.enum(BUYER_TIERS),
  /** 2000 = 20%. A whole number from 0 to 10000 (100%). */
  marginBp: z.number().int('Use a whole number of basis points.').min(0).max(10_000),
  /** When the new margin starts, as a date and time with a UTC offset. Leave it out to start now. */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

type CellStatus = 'CURRENT' | 'SCHEDULED' | 'PAST';

/** "1 Dec 2026", in Indian time, for messages. */
const dateText = (date: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(date);

function toCell(
  cell: {
    id: string;
    skuClass: SkuClass;
    buyerTier: BuyerTier;
    marginBp: number;
    effectiveFrom: Date;
    createdBy: unknown;
    createdAt: Date;
  },
  status: CellStatus,
  creator: { id: string; name: string } | null,
) {
  return {
    id: cell.id,
    skuClass: cell.skuClass,
    buyerTier: cell.buyerTier,
    marginBp: cell.marginBp,
    effectiveFrom: cell.effectiveFrom.toISOString(),
    status,
    createdBy: creator,
    createdAt: cell.createdAt.toISOString(),
  };
}

// Nobody outside Controller, Founder and Admin may even read the matrix.
marginCellsRouter.use('/margin-cells', requireAuth, canSeeMargins);

/**
 * GET /margin-cells  ->  { cells }
 * Every cell ever set (there are only a few dozen: 12 pairs, each changed now and then), grouped by class and tier,
 * newest first. `status` says what each one is today: CURRENT (in use now), SCHEDULED (starts later) or PAST.
 */
marginCellsRouter.get('/margin-cells', async (_req, res) => {
  const now = new Date();
  const cells = await MarginCellModel.find().sort({ effectiveFrom: -1 });

  const people = await UserModel.find({ _id: { $in: cells.map((cell) => cell.createdBy) } }).select(
    'name',
  );
  const nameOf = new Map(people.map((person) => [person.id, person.name]));

  // Newest first, so the first started cell of each class + tier is the one in use now.
  const hasCurrent = new Set<string>();
  const rows = cells.map((cell) => {
    const pair = `${cell.skuClass}/${cell.buyerTier}`;
    let status: CellStatus = 'SCHEDULED';
    if (cell.effectiveFrom <= now) {
      status = hasCurrent.has(pair) ? 'PAST' : 'CURRENT';
      hasCurrent.add(pair);
    }
    const creatorId = String(cell.createdBy);
    const name = nameOf.get(creatorId);
    return toCell(cell, status, name === undefined ? null : { id: creatorId, name });
  });

  rows.sort(
    (a, b) =>
      a.skuClass.localeCompare(b.skuClass) ||
      BUYER_TIERS.indexOf(a.buyerTier) - BUYER_TIERS.indexOf(b.buyerTier) ||
      b.effectiveFrom.localeCompare(a.effectiveFrom),
  );
  res.json({ cells: rows });
});

/**
 * POST /margin-cells  { skuClass, buyerTier, marginBp, effectiveFrom? }  ->  201 { cell }
 * Founder and Admin, after a password check (428 STEP_UP_REQUIRED otherwise). The start cannot be in the past, and
 * must be later than every cell already set for this class and tier, so the newest cell is always the one that wins.
 */
marginCellsRouter.post('/margin-cells', canEditMasters, requireStepUp, async (req, res) => {
  const body = createBody.parse(req.body);
  const me = currentUserOf(req);

  const now = new Date();
  const startsAt = body.effectiveFrom ? new Date(body.effectiveFrom) : now;
  // A minute of slack, so a start typed as "now" is not refused because a second went by.
  if (startsAt.getTime() < now.getTime() - 60_000) {
    throw badRequest('The start cannot be in the past. A new margin starts now or later.');
  }

  const latest = await MarginCellModel.findOne({
    skuClass: body.skuClass,
    buyerTier: body.buyerTier,
  }).sort({ effectiveFrom: -1 });
  if (latest && latest.effectiveFrom >= startsAt) {
    throw conflict(
      `This class and tier already has a margin starting on ${dateText(latest.effectiveFrom)}. Choose a later start.`,
      MARGIN_CELL_EXISTS,
    );
  }

  const cell = await MarginCellModel.create({
    skuClass: body.skuClass,
    buyerTier: body.buyerTier,
    marginBp: body.marginBp,
    effectiveFrom: startsAt,
    createdBy: me.id,
  }).catch(
    failIfDuplicate(
      'This class and tier already has a margin starting at that time.',
      MARGIN_CELL_EXISTS,
    ),
  );

  await writeAudit(req, {
    action: 'margin_cell.create',
    entityType: 'MarginCell',
    entityId: cell.id,
    after: {
      skuClass: cell.skuClass,
      buyerTier: cell.buyerTier,
      marginBp: cell.marginBp,
      effectiveFrom: cell.effectiveFrom.toISOString(),
    },
  });

  res.status(201).json({
    cell: toCell(cell, startsAt > now ? 'SCHEDULED' : 'CURRENT', { id: me.id, name: me.name }),
  });
});
