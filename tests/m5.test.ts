import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pile } from '../src/models/Pile.js';
import { Pool } from '../src/models/Pool.js';
import { PoolCommitment } from '../src/models/PoolCommitment.js';
import { So } from '../src/models/So.js';
import { Refund } from '../src/models/Refund.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { BuyerLocation } from '../src/models/BuyerLocation.js';
import { Sku } from '../src/models/Sku.js';
import { signAccessToken } from '../src/shared/tokens.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import * as poolService from '../src/modules/pool/pool.service.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

const app = createApp();

function idemKey(): string {
  return `m5-${Date.now()}-${Math.random()}`;
}

/**
 * Every "id" this suite passes to a *service* function or signs into a
 * token must be the shared `Counterparty._id`, not the `Buyer`/`Seller`
 * sub-document id — the two are different documents. This bundles both
 * for each party so call sites never have to guess which one a given
 * function wants.
 */
interface PartyIds {
  docId: string; // Buyer._id or Seller._id — what `So.buyerId`/`PoolCommitment.buyerId` store.
  counterpartyId: string; // What `req.auth.counterpartyId` and every `*CounterpartyId` service param wants.
}

async function partyIds(kind: 'buyer' | 'seller', docId: string): Promise<PartyIds> {
  const doc = kind === 'buyer' ? await Buyer.findById(docId) : await Seller.findById(docId);
  return {
    docId,
    counterpartyId: (doc!.counterpartyId as unknown as { toString(): string }).toString(),
  };
}

async function tokenFor(party: PartyIds): Promise<string> {
  return signAccessToken({
    sub: party.counterpartyId,
    actorType: 'counterparty',
    counterpartyId: party.counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

async function seedFixture() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');

  const tehsilA = await createTehsil();
  const tehsilB = await createTehsil();

  const seller = await partyIds(
    'seller',
    await createApprovedSellerAtTehsils(app, purchase.token, [tehsilA]),
  );
  // BR-153 — pools exclude `New` tier sellers; the seed default is `New`,
  // so pool tests need a real supplier eligible to trigger one.
  await Seller.updateOne({ _id: seller.docId }, { $set: { trustTier: 'Verified' } });
  const buyerInScope = await partyIds(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'dealer'),
  );
  const buyerOutOfScope = await partyIds(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilB, 'dealer'),
  );
  const buyerRetailer = await partyIds(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'retailer'),
  );
  const buyerDistributor = await partyIds(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'distributor'),
  );

  const skuId = await createTestSku('B');
  // The task's own demo seed matrix, class B row.
  await seedMarginCell('B', 'Distributor', 0.02, admin.employeeId);
  await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);
  await seedMarginCell('B', 'Retailer', 0.05, admin.employeeId);
  await seedMarginCell('B', 'Trader', 0.015, admin.employeeId);

  return {
    admin,
    sales,
    purchase,
    tehsilA,
    tehsilB,
    seller,
    buyerInScope,
    buyerOutOfScope,
    buyerRetailer,
    buyerDistributor,
    skuId,
  };
}

async function createListingViaApi(
  sellerToken: string,
  input: {
    productId: string;
    skuId: string;
    ratePaise: number;
    moqExact?: number;
    scopeType?: string;
  },
) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      productId: input.productId,
      scopeType: input.scopeType ?? 'my_area',
      lines: [
        {
          skuId: input.skuId,
          ratePaise: input.ratePaise,
          expiryBand: 'over12',
          moqExact: input.moqExact ?? 1,
          deliveryBand: '48h',
          provenance: 'auth',
          batch: 'BATCH-1',
          qty: 100,
        },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.data as { listingId: string; lineIds: string[] };
}

async function getProductIdForSku(skuId: string): Promise<string> {
  const sku = await Sku.findById(skuId);
  return (sku!.productId as unknown as string).toString();
}

async function createLocationFor(buyerDocId: string, salesEmployeeId: string): Promise<string> {
  const b = await Buyer.findById(buyerDocId);
  const loc = await BuyerLocation.create({
    buyerId: b!._id,
    label: 'Warehouse',
    address: 'Test address',
    pin: '452001',
    licenceNo: 'LIC-X',
    approvedBy: salesEmployeeId,
    approvedAt: new Date(),
    isPrimary: true,
  });
  return (loc._id as unknown as string).toString();
}

describe('WF-03 resolver / BR-060 wall — buyer feed and buy screen', () => {
  it('a listing outside the buyer tehsil is absent from the feed, and a direct link 404s the same as nonexistent', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
    });

    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const outOfScopeToken = await tokenFor(fixture.buyerOutOfScope);

    const feedIn = await request(app)
      .get('/api/v1/listings')
      .set('Authorization', `Bearer ${inScopeToken}`);
    expect(feedIn.status).toBe(200);
    expect(feedIn.body.data.some((c: { productId: string }) => c.productId === productId)).toBe(
      true,
    );

    const feedOut = await request(app)
      .get('/api/v1/listings')
      .set('Authorization', `Bearer ${outOfScopeToken}`);
    expect(feedOut.body.data.some((c: { productId: string }) => c.productId === productId)).toBe(
      false,
    );

    const directLink = await request(app)
      .get(`/api/v1/listings/lines/${lineIds[0]}`)
      .set('Authorization', `Bearer ${outOfScopeToken}`);
    expect(directLink.status).toBe(404);
    expect(directLink.body.error.code).toBe('NOT_VISIBLE');

    const nonExistent = await request(app)
      .get('/api/v1/listings/lines/000000000000000000000000')
      .set('Authorization', `Bearer ${outOfScopeToken}`);
    expect(nonExistent.status).toBe(404);
    expect(nonExistent.body.error.code).toBe('NOT_VISIBLE');
  });

  it('BR-060 — the buyer is shown his own tier rate, never the seller net, anywhere in the response', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const sellerNetPaise = 40000;
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: sellerNetPaise,
    });

    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const buyRes = await request(app)
      .get(`/api/v1/listings/lines/${lineIds[0]}`)
      .set('Authorization', `Bearer ${inScopeToken}`);
    expect(buyRes.status).toBe(200);

    // Dealer, class B, 3.5% margin per the seeded demo matrix. The buyer's
    // rate is GST-inclusive (DEC-045): margin on the taxable seller net,
    // then grossed up by 18% GST.
    const expectedTaxable = Math.round(sellerNetPaise * 1.035);
    const expectedBuyerRate = Math.round((expectedTaxable * 118) / 100);
    expect(buyRes.body.data.ratePaise).toBe(expectedBuyerRate);

    const raw = JSON.stringify(buyRes.body);
    expect(raw).not.toContain(String(sellerNetPaise));
    expect(raw.toLowerCase()).not.toContain('sellerid');
    expect(raw.toLowerCase()).not.toContain('sellernet');
  });

  it('IC-01/BR-102 — expiryExact never appears until the seller confirms supply', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
    });
    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const buyRes = await request(app)
      .get(`/api/v1/listings/lines/${lineIds[0]}`)
      .set('Authorization', `Bearer ${inScopeToken}`);
    expect(buyRes.body.data.conditions.expiryExact).toBeUndefined();
  });
});

describe('WF-05 piles — the deferred-commit confirm, and the mandatory gates', () => {
  it('confirming without exact expiry refuses', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
    });
    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const locationId = await createLocationFor(
      fixture.buyerInScope.docId,
      fixture.sales.employeeId,
    );

    const inquireRes = await request(app)
      .post(`/api/v1/listings/lines/${lineIds[0]}/inquire`)
      .set('Authorization', `Bearer ${inScopeToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ qty: 10, deliveryLocationId: locationId });
    expect(inquireRes.status).toBe(201);
    const pileId = inquireRes.body.data.pileId as string;

    await expect(
      demandService.confirmPile(
        fixture.seller.counterpartyId,
        pileId,
        { canSendBoxes: 10, expiryExact: '' },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'EXPIRY_REQUIRED' });
  });

  it('confirm schedules the fan-out; running it creates the SO at this buyer’s own rate and decrements qty', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
    });
    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const locationId = await createLocationFor(
      fixture.buyerInScope.docId,
      fixture.sales.employeeId,
    );

    const inquireRes = await request(app)
      .post(`/api/v1/listings/lines/${lineIds[0]}/inquire`)
      .set('Authorization', `Bearer ${inScopeToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ qty: 10, deliveryLocationId: locationId });
    const pileId = inquireRes.body.data.pileId as string;

    const confirmed = await demandService.confirmPile(
      fixture.seller.counterpartyId,
      pileId,
      { canSendBoxes: 10, expiryExact: '06/2028', batch: 'B-1' },
      'test',
    );
    expect(confirmed.undoWindowMs).toBe(5000);

    // Run the deferred job directly rather than waiting on the real clock.
    await demandService.runConfirmPileFanout(pileId);

    const pileAfter = await Pile.findById(pileId);
    expect(pileAfter!.executedAt).not.toBeNull();

    const so = await So.findOne({ buyerId: fixture.buyerInScope.docId });
    expect(so).not.toBeNull();
    expect(so!.state).toBe('awaiting_payment');

    const lineAfter = await ListingLine.findById(lineIds[0]);
    expect(lineAfter!.qty).toBe(90); // 100 - 10.
  }, 20000);

  it('undo within the window cancels the job — no SO is ever created', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    const { lineIds } = await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
    });
    const inScopeToken = await tokenFor(fixture.buyerInScope);
    const locationId = await createLocationFor(
      fixture.buyerInScope.docId,
      fixture.sales.employeeId,
    );

    const inquireRes = await request(app)
      .post(`/api/v1/listings/lines/${lineIds[0]}/inquire`)
      .set('Authorization', `Bearer ${inScopeToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ qty: 10, deliveryLocationId: locationId });
    const pileId = inquireRes.body.data.pileId as string;

    await demandService.confirmPile(
      fixture.seller.counterpartyId,
      pileId,
      { canSendBoxes: 10, expiryExact: '06/2028', batch: 'B-1' },
      'test',
    );
    await demandService.undoPileConfirm(fixture.seller.counterpartyId, pileId);

    // Even if the job somehow still ran, the guard inside it checks decision === 'confirmed'.
    await demandService.runConfirmPileFanout(pileId);

    const so = await So.findOne({ buyerId: fixture.buyerInScope.docId });
    expect(so).toBeNull();
    const pileAfter = await Pile.findById(pileId);
    expect(pileAfter!.decision).toBeNull();
  }, 20000);
});

describe('BR-140 — the claim board ships off', () => {
  it('404s when config.claim_board is not enabled', async () => {
    const fixture = await seedFixture();
    const sellerToken = await tokenFor(fixture.seller);
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(404);
  });
});

describe('WF-10 pools — trigger on binding, not committed; own tier rate per buyer', () => {
  it('does not trigger merely on total committed quantity reaching MOQ', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
      moqExact: 10,
    });

    const pool = await Pool.findOne({ skuId: fixture.skuId, isActive: true });
    expect(pool).not.toBeNull();
    expect(pool!.moq).toBe(10);
    const poolId = (pool!._id as unknown as string).toString();

    const dealerLoc = await createLocationFor(fixture.buyerInScope.docId, fixture.sales.employeeId);
    const retailerLoc = await createLocationFor(
      fixture.buyerRetailer.docId,
      fixture.sales.employeeId,
    );
    const distributorLoc = await createLocationFor(
      fixture.buyerDistributor.docId,
      fixture.sales.employeeId,
    );

    // buyer1 (dealer) commits 6 — 60% of 10, still below the 75% reconfirm line.
    await poolService.commitToPool(fixture.buyerInScope.counterpartyId, poolId, {
      qty: 6,
      deliveryLocationId: dealerLoc,
    });
    let poolAfter = await Pool.findById(poolId);
    expect(poolAfter!.status).toBe('open');

    const poolSoCount = () =>
      So.countDocuments({
        buyerId: {
          $in: [
            fixture.buyerInScope.docId,
            fixture.buyerRetailer.docId,
            fixture.buyerDistributor.docId,
          ],
        },
      });

    // buyer2 (retailer) commits 4 — total 10 = 100% of MOQ, but nothing is
    // binding yet (both pre-75% commitments are soft) — must NOT trigger.
    await poolService.commitToPool(fixture.buyerRetailer.counterpartyId, poolId, {
      qty: 4,
      deliveryLocationId: retailerLoc,
    });
    poolAfter = await Pool.findById(poolId);
    expect(poolAfter!.status).toBe('reconfirm'); // Crossed 75% of committed, correctly — but:
    expect(await poolSoCount()).toBe(0); // Still no chain exists — binding qty is 0.

    // buyer1 reconfirms — now binding, but only 6 of 10, still short.
    await poolService.reconfirmPool(fixture.buyerInScope.counterpartyId, poolId);
    expect(await poolSoCount()).toBe(0);

    // buyer2 stays silent (never reconfirms). buyer3 (distributor) joins
    // post-reconfirm — binding on entry — pushing binding qty to 10 = MOQ.
    await poolService.commitToPool(fixture.buyerDistributor.counterpartyId, poolId, {
      qty: 4,
      deliveryLocationId: distributorLoc,
    });

    poolAfter = await Pool.findById(poolId);
    expect(poolAfter!.status).toBe('triggered');

    // buyer2 (silent) is dropped, no strike — just excluded, no SO for him.
    const buyer2Commitment = await PoolCommitment.findOne({
      poolId,
      buyerId: fixture.buyerRetailer.docId,
    });
    expect(buyer2Commitment!.withdrawnAt).not.toBeNull();

    // buyer1 and buyer3 each got their own SO, at their own tier's rate —
    // both against the SAME seller-net rate (40000), so the totals differ.
    const soDealer = await So.findOne({ buyerId: fixture.buyerInScope.docId });
    const soDistributor = await So.findOne({ buyerId: fixture.buyerDistributor.docId });
    expect(soDealer).not.toBeNull();
    expect(soDistributor).not.toBeNull();
    expect(soDealer!.totalPaise).not.toBe(soDistributor!.totalPaise); // 3.5% vs 2.0% margin — different totals.
  }, 30000);

  it('BR-158 — a short close refunds every unpaid buyer and reopens the pool as a fresh document', async () => {
    const fixture = await seedFixture();
    const productId = await getProductIdForSku(fixture.skuId);
    const sellerToken = await tokenFor(fixture.seller);
    await createListingViaApi(sellerToken, {
      productId,
      skuId: fixture.skuId,
      ratePaise: 40000,
      moqExact: 5,
    });
    const pool = await Pool.findOne({ skuId: fixture.skuId, isActive: true });
    const poolId = (pool!._id as unknown as string).toString();

    const loc1 = await createLocationFor(fixture.buyerInScope.docId, fixture.sales.employeeId);
    const loc2 = await createLocationFor(fixture.buyerRetailer.docId, fixture.sales.employeeId);

    await poolService.commitToPool(fixture.buyerInScope.counterpartyId, poolId, {
      qty: 4,
      deliveryLocationId: loc1,
    });
    await poolService.reconfirmPool(fixture.buyerInScope.counterpartyId, poolId);
    await poolService.commitToPool(fixture.buyerRetailer.counterpartyId, poolId, {
      qty: 1,
      deliveryLocationId: loc2,
    });

    const triggered = await Pool.findById(poolId);
    expect(triggered!.status).toBe('triggered');

    const result = await poolService.resolvePoolShortfall(poolId, false, {
      employeeId: fixture.purchase.employeeId,
      correlationId: 'test',
    });
    expect(result.reopenedPoolId).toBeDefined();

    const original = await Pool.findById(poolId);
    expect(original!.status).toBe('reopened');
    expect(original!.isActive).toBe(false);

    const reopened = await Pool.findById(result.reopenedPoolId);
    expect(reopened!.status).toBe('open');
    expect(reopened!.isActive).toBe(true);
    expect(reopened!.conditionSetKey).toBe(original!.conditionSetKey);

    const refunds = await Refund.find({ reasonCode: 'supply_failure_full' });
    expect(refunds.length).toBeGreaterThanOrEqual(2);

    const cancelledSos = await So.find({
      buyerId: { $in: [fixture.buyerInScope.docId, fixture.buyerRetailer.docId] },
    });
    expect(cancelledSos.every((so) => so.state === 'cancelled')).toBe(true);
  }, 30000);
});
