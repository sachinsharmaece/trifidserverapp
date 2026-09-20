import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Claim } from '../src/models/Claim.js';
import { Config } from '../src/models/Config.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { Pool } from '../src/models/Pool.js';
import { Po } from '../src/models/Po.js';
import { So } from '../src/models/So.js';
import * as poolService from '../src/modules/pool/pool.service.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import * as controllerService from '../src/modules/controller/controller.service.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';
import {
  createListingViaApi,
  createLocationFor,
  newSeller,
  productIdForSku,
  seedTradeFixture,
  tokenFor,
} from './m8helpers.js';

/**
 * Milestone 9 — concurrency beyond M4's (CH §25.6): real races, not sequential
 * calls in a hurry. Each fires the competing calls in one `Promise.all` so they
 * genuinely overlap on the database.
 */
const app = createApp();
const key = (): string => `m9c-${Date.now()}-${Math.random()}`;

async function openPool(moq: number) {
  const fx = await seedTradeFixture(app);
  const productId = await productIdForSku(fx.skuId);
  await createListingViaApi(app, await tokenFor(fx.seller), {
    productId,
    skuId: fx.skuId,
    ratePaise: 40000,
    moqExact: moq,
  });
  const pool = (await Pool.findOne({ skuId: fx.skuId, isActive: true }))!;
  const poolId = String(pool._id);
  const locate = (buyer: { docId: string }) => createLocationFor(buyer.docId, fx.sales.employeeId);
  return { fx, poolId, locate };
}

describe('two pool commitments crossing 75% at the same instant', () => {
  it('re-confirmation is requested once — one status change, and no soft committer told twice', async () => {
    const { fx, poolId, locate } = await openPool(10);
    // Dealer holds 6 of 10 (soft). Two more join at once: 6+1 and 6+1+1 straddle the 7.5 line.
    await poolService.commitToPool(fx.buyerDealer.counterpartyId, poolId, {
      qty: 6,
      deliveryLocationId: await locate(fx.buyerDealer),
    });
    const [locRetailer, locDistributor] = [
      await locate(fx.buyerRetailer),
      await locate(fx.buyerDistributor),
    ];

    await Promise.all([
      poolService.commitToPool(fx.buyerRetailer.counterpartyId, poolId, {
        qty: 1,
        deliveryLocationId: locRetailer,
      }),
      poolService.commitToPool(fx.buyerDistributor.counterpartyId, poolId, {
        qty: 1,
        deliveryLocationId: locDistributor,
      }),
    ]);

    const pool = (await Pool.findById(poolId))!;
    expect(pool.status).toBe('reconfirm');
    // pool_75 is per soft committer, once each: the dealer must not be asked twice.
    const dealerAsks = await NotificationOutbox.countDocuments({
      counterpartyId: fx.buyerDealer.counterpartyId,
      templateKey: 'pool_75',
      correlationId: `pool-${poolId}`,
    });
    expect(dealerAsks).toBe(1);
  }, 60000);
});

describe('two binding commitments crossing the MOQ at the same instant', () => {
  it('the pool triggers once: each binding buyer gets exactly one SO, never two', async () => {
    const { fx, poolId, locate } = await openPool(10);
    // 8 of 10 crosses 75%, so the pool enters `reconfirm`; the dealer then re-confirms (8 binding).
    await poolService.commitToPool(fx.buyerDealer.counterpartyId, poolId, {
      qty: 8,
      deliveryLocationId: await locate(fx.buyerDealer),
    });
    expect((await Pool.findById(poolId))!.status).toBe('reconfirm');
    await poolService.reconfirmPool(fx.buyerDealer.counterpartyId, poolId);

    const [locRetailer, locDistributor] = [
      await locate(fx.buyerRetailer),
      await locate(fx.buyerDistributor),
    ];
    // Joiners after the re-confirm are binding on entry: 8 + 1 + 1 = 10 = MOQ, together —
    // neither alone reaches it, so both hit the trigger at once.
    await Promise.all([
      poolService.commitToPool(fx.buyerRetailer.counterpartyId, poolId, {
        qty: 1,
        deliveryLocationId: locRetailer,
      }),
      poolService.commitToPool(fx.buyerDistributor.counterpartyId, poolId, {
        qty: 1,
        deliveryLocationId: locDistributor,
      }),
    ]);

    expect((await Pool.findById(poolId))!.status).toBe('triggered');
    for (const buyer of [fx.buyerDealer, fx.buyerRetailer, fx.buyerDistributor]) {
      expect(await So.countDocuments({ buyerId: buyer.docId }), buyer.docId).toBe(1);
    }
  }, 60000);
});

describe('two claim-board claims on the same pile', () => {
  it('first-come-wins under a real race: exactly one claim lands, the rest are refused', async () => {
    await Claim.init(); // the partial unique index must exist before the race
    const previous = await Config.findOne({ key: 'claim_board' });
    await Config.findOneAndUpdate(
      { key: 'claim_board' },
      { $set: { value: true } },
      { upsert: true },
    );
    try {
      const sellers = await Promise.all([1, 2, 3, 4, 5].map(() => newSeller(app)));
      const pileId = String(new (await import('mongoose')).Types.ObjectId());

      const outcomes = await Promise.allSettled(
        sellers.map((s) => demandService.claimPile(s.counterpartyId, pileId)),
      );
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter(
        (o) =>
          o.status === 'rejected' &&
          (o.reason as { code?: string }).code === 'PILE_ALREADY_DECIDED',
      );
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(4);
      expect(await Claim.countDocuments({ pileId, undoneAt: null })).toBe(1);

      // Undo frees the pile: a fresh claim then lands — the partial index only guards live claims.
      const winner = won[0] as PromiseFulfilledResult<{ claimId: string }>;
      const winnerSeller = sellers[outcomes.indexOf(won[0]!)]!;
      await demandService.undoClaim(winnerSeller.counterpartyId, winner.value.claimId);
      const other = sellers.find((s) => s !== winnerSeller)!;
      await expect(demandService.claimPile(other.counterpartyId, pileId)).resolves.toBeDefined();
    } finally {
      if (previous) {
        await Config.updateOne({ key: 'claim_board' }, { $set: { value: previous.value } });
      } else {
        await Config.deleteOne({ key: 'claim_board' });
      }
    }
  }, 60000);
});

describe('the bulk lifeline (BR-234) under concurrency', () => {
  async function releasedPo() {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const accounts = await staffToken(app, 'accounts');
    const admin = await staffToken(app, 'admin');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const skuId = await createTestSku();
    await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);
    const so = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', key())
      .send({
        buyerId,
        sellerId,
        skuId,
        boxes: 10,
        sellerNetPaise: 40000,
        placeOfSupply: 'intra_state',
      });
    const soId = so.body.data.soId as string;
    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
      amountPaise: (await So.findById(soId))!.totalPaise,
      method: 'utr',
      utr: `UTR-${Math.random()}`,
    });
    await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
      employeeId: sales.employeeId,
      correlationId: 'm9c',
    });
    await paymentService.postBankCredit(
      upcomingReceiptId,
      { utr: `S-${Math.random()}`, remitterAccountNumber: '1', remitterIfsc: 'HDFC0001234' },
      { employeeId: accounts.employeeId, correlationId: 'm9c' },
    );
    const po = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', key())
      .send({});
    return { poId: po.body.data.poId as string, sales, purchase };
  }

  it('two simultaneous lifelines of 24h extend an open PO by 48h — neither extension is lost', async () => {
    const { poId, sales, purchase } = await releasedPo();
    const before = (await Po.findById(poId))!.dispatchDueDate.getTime();
    const hour = 60 * 60 * 1000;

    await Promise.all([
      controllerService.grantBulkLifeline(24, 'festival A', {
        employeeId: sales.employeeId,
        checkerEmployeeId: purchase.employeeId,
        correlationId: 'm9c-a',
      }),
      controllerService.grantBulkLifeline(24, 'festival B', {
        employeeId: sales.employeeId,
        checkerEmployeeId: purchase.employeeId,
        correlationId: 'm9c-b',
      }),
    ]);

    const after = (await Po.findById(poId))!.dispatchDueDate.getTime();
    expect(after - before).toBe(48 * hour);
  }, 120000);
});
