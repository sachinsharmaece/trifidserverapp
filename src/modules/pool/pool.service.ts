import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Pool, buildConditionSetKey } from '../../models/Pool.js';
import { PoolCommitment } from '../../models/PoolCommitment.js';
import { ListingLine } from '../../models/ListingLine.js';
import { Listing } from '../../models/Listing.js';
import { Seller } from '../../models/Seller.js';
import { Buyer } from '../../models/Buyer.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Refund } from '../../models/Refund.js';
import { So } from '../../models/So.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { addHours, formatForDisplay } from '../../shared/clock.js';
import {
  enqueueNotification,
  counterpartyIdForBuyer,
} from '../notification/notification.outbox.js';
import type { Paise } from '../../shared/money.js';
import { createSoInSession } from '../chain/chain.service.js';
import { computeBuyerFacingRatePaise } from '../listing/listing.service.js';

const PAY_WINDOW_HOURS = 16; // BR-156.
const RECONFIRM_THRESHOLD = 0.75; // BR-154.

async function requireActiveBuyer(buyerCounterpartyId: string) {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  return buyer;
}

async function isBuyerBlockedBySupplier(
  sellerId: Types.ObjectId,
  buyerGstin: string,
): Promise<boolean> {
  const block = await SellerBlock.findOne({ sellerId, gstin: buyerGstin, status: 'active' });
  return !!block;
}

interface PoolSummaryDto {
  poolId: string;
  skuId: string;
  moq: number;
  status: string;
  bindingQty: number;
  totalQty: number;
  payDeadline: Date | null;
}

async function summarize(pool: InstanceType<typeof Pool>): Promise<PoolSummaryDto> {
  const commitments = await PoolCommitment.find({ poolId: pool._id, withdrawnAt: null });
  const bindingQty = commitments.filter((c) => c.isBinding).reduce((sum, c) => sum + c.qty, 0);
  const totalQty = commitments.reduce((sum, c) => sum + c.qty, 0);
  return {
    poolId: (pool._id as Types.ObjectId).toString(),
    skuId: (pool.skuId as Types.ObjectId).toString(),
    moq: pool.moq,
    status: pool.status,
    bindingQty,
    totalQty,
    payDeadline: pool.payDeadline ?? null,
  };
}

/** API-060 GET /pools. Pools open on any SKU belonging to this product. */
export async function getPoolsForProduct(skuIds: string[]): Promise<PoolSummaryDto[]> {
  const pools = await Pool.find({ skuId: { $in: skuIds }, isActive: true });
  return Promise.all(pools.map(summarize));
}

interface PoolDetailDto extends PoolSummaryDto {
  myRatePaise?: Paise; // BR-160 — this buyer's own tier rate, so a saving can be shown.
  myCommitment?: {
    qty: number;
    isBinding: boolean;
    reconfirmedAt: Date | null;
    paidAt: Date | null;
  };
}

/** API-060 GET /pools/:id. */
export async function getPool(
  buyerCounterpartyId: string | null,
  poolId: string,
): Promise<PoolDetailDto> {
  const pool = await Pool.findById(poolId);
  if (!pool) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pool not found.' });
  const summary = await summarize(pool);

  if (!buyerCounterpartyId) return summary;
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) return summary;

  const supplier = await findCurrentSupplier(pool);
  const myRatePaise = supplier
    ? ((await computeBuyerFacingRatePaise(buyer, pool.skuId, supplier.sellerNetPaise)) ?? undefined)
    : undefined;

  const mine = await PoolCommitment.findOne({
    poolId: pool._id,
    buyerId: buyer._id,
    withdrawnAt: null,
  });
  if (!mine) return { ...summary, myRatePaise };
  return {
    ...summary,
    myRatePaise,
    myCommitment: {
      qty: mine.qty,
      isBinding: mine.isBinding,
      reconfirmedAt: mine.reconfirmedAt ?? null,
      paidAt: mine.paidAt ?? null,
    },
  };
}

/**
 * Finds the seller who supplies the pool right now (BR-152/BR-153):
 * whoever holds the lowest rate on this exact condition-set key, excluding
 * `New` tier sellers. No incumbent right, no last look — recomputed fresh
 * every time this is called, including at trigger.
 */
async function findCurrentSupplier(
  pool: InstanceType<typeof Pool>,
): Promise<{ sellerId: Types.ObjectId; sellerNetPaise: number } | null> {
  const liveListings = await Listing.find({ state: 'live' });
  const lines = await ListingLine.find({
    listingId: { $in: liveListings.map((l) => l._id) },
    skuId: pool.skuId,
    expiryBand: pool.expiryBand,
    moqBand: pool.moqBand,
    deliveryBand: pool.deliveryBand,
    provenance: pool.provenance,
  }).sort({ ratePaise: 1 });

  const listingBySellerLine = new Map(
    liveListings.map((l) => [(l._id as Types.ObjectId).toString(), l]),
  );
  for (const line of lines) {
    const listing = listingBySellerLine.get((line.listingId as Types.ObjectId).toString());
    if (!listing) continue;
    const seller = await Seller.findById(listing.sellerId);
    if (!seller || seller.trustTier === 'New') continue; // BR-153.
    return { sellerId: seller._id as Types.ObjectId, sellerNetPaise: line.ratePaise };
  }
  return null;
}

interface CommitInput {
  qty: number;
  deliveryLocationId: string;
}

/**
 * API-061. BR-154 — before 75%, soft/free/withdrawable; after 75%, binding
 * on entry. Exclusion is enforced at join time, before composition is set
 * (`CH §3.10.7`) — checked against whoever currently supplies the pool.
 */
export async function commitToPool(
  buyerCounterpartyId: string,
  poolId: string,
  input: CommitInput,
): Promise<{ poolId: string; isBinding: boolean }> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const counterparty = await Counterparty.findById(buyer.counterpartyId);
  if (counterparty?.status === 'blacklisted') {
    // QR-015 — blacklist blocks new pool joins. `counterparty` is already in
    // hand here, so this reads it directly rather than calling
    // assertCounterpartyActive and re-fetching the same document.
    throw new AppError({
      code: 'ACCOUNT_NOT_ACTIVE',
      messageEn: 'This account is blocked. Call the sales desk for help.',
    });
  }
  const pool = await Pool.findById(poolId);
  if (!pool || !pool.isActive)
    throw new AppError({ code: 'POOL_CLOSED', messageEn: 'This pool is not open.' });

  const supplier = await findCurrentSupplier(pool);
  if (supplier && (await isBuyerBlockedBySupplier(supplier.sellerId, counterparty?.gstin ?? ''))) {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }

  const existing = await PoolCommitment.findOne({ poolId: pool._id, buyerId: buyer._id });
  if (existing && !existing.withdrawnAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'You are already committed to this pool.',
    });
  }

  const isBinding = pool.status === 'reconfirm' || pool.status === 'triggered';
  if (existing) {
    existing.withdrawnAt = null;
    existing.qty = input.qty;
    existing.isBinding = isBinding;
    existing.deliveryLocationId = input.deliveryLocationId as unknown as Types.ObjectId;
    await existing.save();
  } else {
    await PoolCommitment.create({
      poolId: pool._id,
      buyerId: buyer._id,
      qty: input.qty,
      deliveryLocationId: input.deliveryLocationId,
      isBinding,
    });
  }

  // A joiner after trigger pays on joining, at the already-triggered rate,
  // within the same payment window as everyone else (BR-156).
  if (pool.status === 'triggered' && supplier) {
    await withTransaction(async (session) => {
      const { soNo } = await createSoInSession(
        {
          buyerId: (buyer._id as Types.ObjectId).toString(),
          sellerId: supplier.sellerId.toString(),
          skuId: (pool.skuId as Types.ObjectId).toString(),
          boxes: input.qty,
          sellerNetPaise: supplier.sellerNetPaise,
          placeOfSupply: 'intra_state',
          payDeadlineHours: PAY_WINDOW_HOURS,
          skipPaymentDueNotice: true, // `pool_triggered` below is this SO's payment notice.
        },
        { employeeId: (buyer._id as Types.ObjectId).toString(), correlationId: `pool-${poolId}` },
        session,
      );
      // CH §21.8 #6 — "Pay within 16 hours": a joiner after trigger pays on joining.
      await enqueueNotification(
        {
          counterpartyId: buyer.counterpartyId as Types.ObjectId,
          templateKey: 'pool_triggered',
          params: { soNo, payBy: formatForDisplay(addHours(new Date(), PAY_WINDOW_HOURS)) },
          correlationId: `pool-${poolId}`,
        },
        session,
      );
    });
  } else {
    await checkPoolThresholds(poolId);
  }

  return { poolId, isBinding };
}

/**
 * BR-154/BR-155 — recomputes the 75% re-confirmation and the trigger.
 * Called after every commit/withdraw/reconfirm; safe to call repeatedly.
 */
export async function checkPoolThresholds(poolId: string): Promise<void> {
  const pool = await Pool.findById(poolId);
  if (!pool || pool.status === 'triggered' || pool.status === 'converted') return;

  const commitments = await PoolCommitment.find({ poolId: pool._id, withdrawnAt: null });
  const totalQty = commitments.reduce((sum, c) => sum + c.qty, 0);
  const crossedThreshold = totalQty >= pool.moq * RECONFIRM_THRESHOLD;

  if (crossedThreshold && pool.status === 'open' && !pool.reconfirmRequestedAt) {
    // BR-154 — one re-confirmation request to every existing (still
    // non-binding) committer. New joiners from here on commit binding.
    // TD-004 — the threshold crossing and every `pool_75` commit together.
    await withTransaction(async (session) => {
      pool.status = 'reconfirm';
      pool.reconfirmRequestedAt = new Date();
      await pool.save({ session });

      // CH §21.8 #5 — "Pool hits 75% — re-confirm or withdraw."
      for (const commitment of commitments.filter((c) => !c.isBinding)) {
        await enqueueNotification(
          {
            counterpartyId: await counterpartyIdForBuyer(
              commitment.buyerId as Types.ObjectId,
              session,
            ),
            templateKey: 'pool_75',
            params: { poolId },
            correlationId: `pool-${poolId}`,
          },
          session,
        );
      }
    });
    return;
  }

  const bindingQty = commitments.filter((c) => c.isBinding).reduce((sum, c) => sum + c.qty, 0);
  if (bindingQty >= pool.moq) {
    await triggerPool(poolId);
  }
}

/**
 * BR-155 — triggers on binding quantity, never committed. Any commitment
 * still awaiting its one re-confirmation at the moment of trigger is
 * dropped here, with no strike — "silence is information, bought early."
 */
async function triggerPool(poolId: string): Promise<void> {
  const pool = await Pool.findById(poolId);
  if (!pool || pool.status === 'triggered') return;

  const supplier = await findCurrentSupplier(pool);
  if (!supplier) return; // No eligible (non-`New`) seller currently holds this key — wait.

  const commitments = await PoolCommitment.find({ poolId: pool._id, withdrawnAt: null });

  await withTransaction(async (session) => {
    for (const commitment of commitments) {
      if (!commitment.isBinding) {
        // Never reconfirmed before trigger — dropped, no strike.
        commitment.withdrawnAt = new Date();
        await commitment.save({ session });
        continue;
      }
      const { soId, soNo } = await createSoInSession(
        {
          buyerId: (commitment.buyerId as Types.ObjectId).toString(),
          sellerId: supplier.sellerId.toString(),
          skuId: (pool.skuId as Types.ObjectId).toString(),
          boxes: commitment.qty,
          sellerNetPaise: supplier.sellerNetPaise,
          placeOfSupply: 'intra_state',
          payDeadlineHours: PAY_WINDOW_HOURS,
          skipPaymentDueNotice: true, // `pool_triggered` below is this SO's payment notice.
        },
        {
          employeeId: (commitment.buyerId as Types.ObjectId).toString(),
          correlationId: `pool-${poolId}`,
        },
        session,
      );
      commitment.soId = soId as unknown as Types.ObjectId;
      await commitment.save({ session });

      // BR-155 — inside the commit handler, at the threshold crossing, in the same
      // transaction. CH §21.8 #6 — "Pay within 16 hours."
      await enqueueNotification(
        {
          counterpartyId: await counterpartyIdForBuyer(
            commitment.buyerId as Types.ObjectId,
            session,
          ),
          templateKey: 'pool_triggered',
          params: { soNo, payBy: formatForDisplay(addHours(new Date(), PAY_WINDOW_HOURS)) },
          correlationId: `pool-${poolId}`,
        },
        session,
      );
    }

    pool.status = 'triggered';
    pool.triggeredAt = new Date();
    pool.payDeadline = addHours(new Date(), PAY_WINDOW_HOURS);
    await pool.save({ session });

    await writeAuditLog(
      {
        actorId: supplier.sellerId,
        actorType: 'counterparty',
        entity: 'pool',
        entityId: pool._id as Types.ObjectId,
        field: 'status',
        newValue: 'triggered',
        correlationId: `pool-${poolId}`,
      },
      session,
    );
  });
}

/** API-062 reconfirm. BR-155 — one re-confirmation per buyer per pool cycle. */
export async function reconfirmPool(buyerCounterpartyId: string, poolId: string): Promise<void> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const commitment = await PoolCommitment.findOne({
    poolId,
    buyerId: buyer._id,
    withdrawnAt: null,
  });
  if (!commitment)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'No commitment on this pool.' });
  if (commitment.reconfirmedAt) {
    throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'Already reconfirmed this cycle.' });
  }
  commitment.reconfirmedAt = new Date();
  commitment.isBinding = true;
  await commitment.save();
  await checkPoolThresholds(poolId);
}

/** API-062 withdraw. Silence (never reconfirming) drops with no strike — same as an explicit withdraw pre-75%. */
export async function withdrawFromPool(buyerCounterpartyId: string, poolId: string): Promise<void> {
  const buyer = await requireActiveBuyer(buyerCounterpartyId);
  const commitment = await PoolCommitment.findOne({
    poolId,
    buyerId: buyer._id,
    withdrawnAt: null,
  });
  if (!commitment)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'No commitment on this pool.' });
  if (commitment.isBinding) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This commitment is binding and can no longer be withdrawn free (BR-154).',
    });
  }
  commitment.withdrawnAt = new Date();
  await commitment.save();
}

/** API-063. BR-159 — the seller closes his own pool short, at the rate he published, unrevisable. */
export async function triggerPoolEarly(
  sellerCounterpartyId: string,
  poolId: string,
): Promise<void> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  const pool = await Pool.findById(poolId);
  if (!pool || pool.status === 'triggered') {
    throw new AppError({ code: 'POOL_CLOSED', messageEn: 'This pool is not open.' });
  }
  const supplier = await findCurrentSupplier(pool);
  if (!supplier || !supplier.sellerId.equals(seller._id as Types.ObjectId)) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn:
        'Only the seller currently holding the lowest rate on this key may trigger it early.',
    });
  }
  // Binding-on-entry for everyone still soft, since the seller is choosing
  // to supply the pool as it stands right now.
  await PoolCommitment.updateMany(
    { poolId: pool._id, withdrawnAt: null, isBinding: false },
    { $set: { isBinding: true } },
  );
  await triggerPool(poolId);
}

/**
 * BR-158 — resolution when the 16h payment window closes short. On-demand
 * staff/desk action rather than a scheduled job, matching M4's own
 * precedent (`CHANGELOG.md`, "the 13:00/16:00/19:00 runs are on-demand, not
 * scheduled") — the underlying resolution is what matters and is fully
 * built; wiring it to a clock is a small, separate follow-up.
 */
export async function resolvePoolShortfall(
  poolId: string,
  sellerWillShipLowerQty: boolean,
  actor: { employeeId: string; correlationId: string },
): Promise<{ reopenedPoolId?: string }> {
  const pool = await Pool.findById(poolId);
  if (!pool || pool.status !== 'triggered') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This pool is not awaiting payment.',
    });
  }
  const commitments = await PoolCommitment.find({
    poolId: pool._id,
    withdrawnAt: null,
    isBinding: true,
  });
  const soIds = commitments.map((c) => c.soId).filter(Boolean) as Types.ObjectId[];
  const sos = await So.find({ _id: { $in: soIds } });
  const unpaidSoIds = sos
    .filter((so) => so.state === 'awaiting_payment')
    .map((so) => so._id as Types.ObjectId);

  if (unpaidSoIds.length === 0) return {}; // Fully paid — nothing to resolve.
  if (sellerWillShipLowerQty) return {}; // Accepted as-is; unpaid buyers simply drop off at their own payment deadline.

  // BR-158 — everyone refunded, pool reopens as a fresh document (never
  // mutated in place — matches the "append, don't edit history" pattern
  // used throughout the money modules).
  return withTransaction(async (session) => {
    for (const so of sos) {
      if (so.state !== 'awaiting_payment') continue;
      await Refund.create(
        [
          {
            chainId: so.chainId,
            buyerId: so.buyerId,
            amountPaise: so.totalPaise,
            reasonCode: 'supply_failure_full',
            state: 'payable',
            targetAccountMasked: 'pool-short-close',
          },
        ],
        { session, ordered: true },
      );
      so.state = 'cancelled';
      await so.save({ session });
    }

    pool.status = 'reopened';
    pool.isActive = false;
    await pool.save({ session });

    const [reopened] = await Pool.create(
      [
        {
          skuId: pool.skuId,
          conditionSetKey: pool.conditionSetKey,
          expiryBand: pool.expiryBand,
          moqBand: pool.moqBand,
          deliveryBand: pool.deliveryBand,
          provenance: pool.provenance,
          moq: pool.moq,
          status: 'open',
          isActive: true,
        },
      ],
      { session, ordered: true },
    );

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'pool',
        entityId: pool._id as Types.ObjectId,
        field: 'status',
        oldValue: 'triggered',
        newValue: 'reopened',
        correlationId: actor.correlationId,
      },
      session,
    );

    return { reopenedPoolId: (reopened!._id as Types.ObjectId).toString() };
  });
}

export { buildConditionSetKey };
