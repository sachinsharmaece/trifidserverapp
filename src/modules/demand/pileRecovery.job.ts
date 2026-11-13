import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Employee } from '../../models/Employee.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Pile, type PileDocument } from '../../models/Pile.js';
import { Product } from '../../models/Product.js';
import { Role } from '../../models/Role.js';
import { Sku } from '../../models/Sku.js';
import { logger } from '../../shared/logger.js';
import { leaderOf } from '../../shared/team.js';
import { notifyStaff } from '../notice/notice.service.js';
import { runConfirmPileFanout } from './pileFanout.job.js';

/**
 * BR-137 / BR-378 — a confirmed pile gives each buyer his deal in a job scheduled 5 seconds after the
 * confirmation. If that job fails, nothing ran it again, and the pile sat "confirmed" with no deal
 * given: off every queue, with no one told. This is the second chance.
 *
 * Every 5 minutes, in the worker process. A pile is picked up when it was confirmed more than
 * `RECOVERY_MIN_AGE_MS` ago (well past BR-137's undo window and the scheduled job's own run) and its
 * fan-out still has not run. `runConfirmPileFanout` is safe to run twice, so a retry that races the
 * scheduled job cannot double-offer.
 *
 * Two limits:
 *  - A pile is retried only within `RECOVERY_MAX_AGE_MS` of its confirmation — the same 24 hours a
 *    deal is held for (BR-378). Past that, giving buyers a deal on stale demand is a decision for
 *    the desk, not for a timer: the pile is flagged and left alone.
 *  - Staff are told once per pile (`stuckNoticedAt`), when a retry fails or the pile is too old to
 *    retry. A retry that works tells no one.
 *
 * `now` is a parameter so the age limits are testable.
 */
export const RECOVERY_MIN_AGE_MS = 2 * 60 * 1000;
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

const STUCK_LINK = '/purchase/confirmations';

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** "WEEDMAR SUPER 500 ML" — the brand and pack only: a Purchase notice names no buyer (BR-365). */
async function packName(pile: PileDocument): Promise<string> {
  const line = await ListingLine.findById(pile.listingLineId, { skuId: 1 });
  const sku = line ? await Sku.findById(line.skuId, { productId: 1, packLabel: 1 }) : null;
  const product = sku ? await Product.findById(sku.productId, { brand: 1 }) : null;
  return product && sku ? `${product.brand} ${sku.packLabel}` : 'a listed pack';
}

/**
 * The person who confirmed it on the seller's behalf, their Purchase leader, and every active
 * Admin — the same people the rate-change notices reach. A pile the seller confirmed himself has no
 * staff member to name, so it goes to Admins alone.
 */
async function recipientsFor(pile: PileDocument): Promise<string[]> {
  const ids: string[] = [];
  const confirmer = [...pile.proxyLog].reverse().find((entry) => entry.action === 'confirm_pile');
  if (confirmer) {
    const confirmerId = String(confirmer.actingStaffId);
    ids.push(confirmerId);
    const leader = await leaderOf('purchase', confirmerId);
    if (leader) ids.push(leader);
  }
  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  if (adminRole) {
    const admins = await Employee.find({ active: true, roleIds: adminRole._id }, { _id: 1 });
    ids.push(...admins.map((admin) => String(admin._id)));
  }
  if (ids.length === 0) return [];
  const active = await Employee.find({ _id: { $in: ids }, active: true }, { _id: 1 });
  return active.map((employee) => String(employee._id));
}

/** Records why it is stuck and, the first time only, tells staff. True when staff were told now. */
async function flagStuckPile(
  pile: PileDocument & { _id: Types.ObjectId },
  reason: string,
  tooOld: boolean,
  now: Date,
): Promise<boolean> {
  const [recipients, name] = await Promise.all([recipientsFor(pile), packName(pile)]);
  const age = formatAge(now.getTime() - (pile.decidedAt ?? now).getTime());
  const boxes = pile.confirmedQty ? `${pile.confirmedQty} boxes ` : '';
  return withTransaction(async (session) => {
    await Pile.updateOne({ _id: pile._id }, { $set: { fanoutError: reason } }, { session });
    const first = await Pile.updateOne(
      { _id: pile._id, stuckNoticedAt: null },
      { $set: { stuckNoticedAt: now } },
      { session },
    );
    if (first.modifiedCount === 0) return false; // Staff were told on an earlier run.
    await notifyStaff(
      recipients,
      {
        kind: 'pile_stuck',
        title: `Confirmation not completed: ${name}`,
        body:
          `${boxes}confirmed ${age} ago and the buyers have no deal yet. ` +
          (tooOld
            ? 'It is too old to retry automatically and needs a decision.'
            : 'It is retried every 5 minutes.'),
        link: STUCK_LINK,
      },
      session,
    );
    return true;
  });
}

export async function runConfirmedPileRecovery(
  now: Date = new Date(),
): Promise<{ recovered: number; flagged: number }> {
  const stuck = await Pile.find({
    decision: 'confirmed',
    executedAt: null,
    decidedAt: { $lte: new Date(now.getTime() - RECOVERY_MIN_AGE_MS) },
  })
    .sort({ decidedAt: 1 })
    .limit(BATCH);

  let recovered = 0;
  let flagged = 0;
  for (const pile of stuck) {
    const pileId = String(pile._id);
    const tooOld = now.getTime() - (pile.decidedAt ?? now).getTime() > RECOVERY_MAX_AGE_MS;
    // Too old and already flagged: nothing new to say, and nothing to retry.
    if (tooOld && pile.stuckNoticedAt) continue;

    let reason = 'Confirmed more than 24 hours ago, so it is not retried automatically.';
    if (!tooOld) {
      try {
        await runConfirmPileFanout(pileId);
        recovered += 1;
        continue;
      } catch (error) {
        logger.error({ msg: 'pile recovery: the fan-out failed again', pileId, error });
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      if (await flagStuckPile(pile, reason.slice(0, 300), tooOld, now)) flagged += 1;
    } catch (error) {
      logger.error({ msg: 'pile recovery: could not flag a stuck pile', pileId, error });
    }
  }
  return { recovered, flagged };
}
