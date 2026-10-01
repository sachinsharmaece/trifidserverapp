import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { Chain } from '../src/models/Chain.js';
import { So } from '../src/models/So.js';
import { SoLine } from '../src/models/SoLine.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pool, buildConditionSetKey } from '../src/models/Pool.js';
import { PoolCommitment } from '../src/models/PoolCommitment.js';
import { BuyerLocation } from '../src/models/BuyerLocation.js';
import { Buyer } from '../src/models/Buyer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Ask } from '../src/models/Ask.js';
import { Sku } from '../src/models/Sku.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

/**
 * Sales desk v2 (work-stream A) — the new read endpoints over existing
 * collections, plus the one new `call_log` collection. Every route reuses
 * `SALES_WORKLIST_READ` as its gate, so each happy path pairs with one
 * permission-boundary check using `transport_logistics`, a role that holds
 * no Sales permission at all.
 */

async function seedSoWithLine(): Promise<{
  buyerId: string;
  sellerId: string;
  soId: string;
  skuId: string;
}> {
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('B');

  const chain = await Chain.create({
    chainNo: `C-TEST-${Date.now()}-${Math.random()}`,
    source: 'inquiry',
  });
  const so = await So.create({
    soNo: `SO-TEST-${Date.now()}-${Math.random()}`,
    chainId: chain._id,
    buyerId,
    sellerId,
    tierAtOrder: 'Dealer',
    placeOfSupply: 'intra_state',
    state: 'awaiting_payment',
    payDeadline: new Date(Date.now() + 16 * 60 * 60 * 1000),
    totalPaise: 118000,
  });
  await SoLine.create({
    soId: so._id,
    skuId,
    boxes: 10,
    ratePaise: 1000,
    classAtOrder: 'B',
    marginPctAtOrder: 0.05,
    sellerNetPaise: 800,
    baseUnitsPerBoxAtOrder: 20,
    baseUnitAtOrder: 'LTR',
    taxablePaise: 100000,
    totalPaise: 118000,
    taxSplit: { cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 },
  });

  return { buyerId, sellerId, soId: (so._id as unknown as string).toString(), skuId };
}

async function seedLiveListingLine(): Promise<{
  productId: string;
  sellerId: string;
  skuId: string;
}> {
  const purchase = await staffToken(app, 'purchase');
  const admin = await staffToken(app, 'admin');
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('B');
  const sku = await Sku.findById(skuId);
  await seedMarginCell('B', 'Retailer', 0.05, admin.employeeId);

  const listing = await Listing.create({
    productId: sku!.productId,
    sellerId,
    origin: 'seller_initiated',
    scopeType: 'all_india',
    frozenTehsilIds: [],
    state: 'live',
    expiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
  });
  await ListingLine.create({
    listingId: listing._id,
    skuId,
    ratePaise: 900,
    expiryBand: 'over12',
    moqExact: 1,
    deliveryBand: '48h',
    provenance: 'company',
    qty: 100,
  });

  return { productId: (sku!.productId as unknown as string).toString(), sellerId, skuId };
}

async function seedPoolWithCommitment(): Promise<{ poolId: string; buyerId: string }> {
  const sales = await staffToken(app, 'sales');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const skuId = await createTestSku('B');
  const buyer = await Buyer.findById(buyerId);
  const location = await BuyerLocation.create({
    buyerId,
    label: 'Main store',
    address: 'Test address',
    pin: '452001',
    licenceNo: 'LIC-1',
    approvedBy: buyer!._id,
    approvedAt: new Date(),
    isPrimary: true,
  });

  const key = {
    expiryBand: 'over12',
    moqBand: 'up25' as const,
    deliveryBand: '48h',
    provenance: 'company',
  };
  const pool = await Pool.create({
    skuId,
    conditionSetKey: buildConditionSetKey(key),
    expiryBand: key.expiryBand,
    moqBand: key.moqBand,
    deliveryBand: key.deliveryBand,
    provenance: key.provenance,
    moq: 10,
    status: 'open',
    isActive: true,
  });
  await PoolCommitment.create({
    poolId: pool._id,
    buyerId,
    qty: 5,
    deliveryLocationId: location._id,
    isBinding: false,
  });

  return { poolId: (pool._id as unknown as string).toString(), buyerId };
}

describe('POST/GET /staff/sales/calls, GET /staff/sales/promises', () => {
  it('creates a call log and reads it back for the buyer', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);

    const createRes = await request(app)
      .post('/api/v1/staff/sales/calls')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerId,
        kind: 'call',
        direction: 'out',
        outcome: 'asked_for_a_rate',
        note: 'Called about DAP rate.',
        promiseDueAt: new Date(Date.now() - 3600_000).toISOString(), // already due, so it shows on the Promised bucket
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.buyerId).toBe(buyerId);
    expect(createRes.body.data.kind).toBe('call');

    const listRes = await request(app)
      .get(`/api/v1/staff/sales/calls?buyerId=${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].note).toBe('Called about DAP rate.');

    const promisesRes = await request(app)
      .get('/api/v1/staff/sales/promises')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(promisesRes.status).toBe(200);
    expect(
      (promisesRes.body.data as Array<{ callLogId: string }>).some(
        (p) => p.callLogId === createRes.body.data.callLogId,
      ),
    ).toBe(true);
  });

  // Regression — the buyer-file call history's "BY" column needs a staff
  // name, not the raw `employeeId` it used to carry.
  it('resolves the logging staff member to a display name, not a raw id', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);

    const createRes = await request(app)
      .post('/api/v1/staff/sales/calls')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerId,
        kind: 'call',
        direction: 'out',
        outcome: 'asked_for_a_rate',
        note: 'Checking the employeeName field.',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.employeeName).toBeTruthy();
    expect(createRes.body.data.employeeName).not.toBe(createRes.body.data.employeeId);

    const listRes = await request(app)
      .get(`/api/v1/staff/sales/calls?buyerId=${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(listRes.body.data[0].employeeName).toBe(createRes.body.data.employeeName);
  });

  it('an update_request without updateKind is refused', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const res = await request(app)
      .post('/api/v1/staff/sales/calls')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ buyerId, kind: 'update_request', note: 'Wants to change something.' });
    expect(res.status).toBe(400);
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/calls?buyerId=000000000000000000000000')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /staff/sales/board, /staff/sales/board/:productId', () => {
  it('lists a product with a live listing line and prices its ladder', async () => {
    const sales = await staffToken(app, 'sales');
    const { productId } = await seedLiveListingLine();

    const boardRes = await request(app)
      .get('/api/v1/staff/sales/board')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(boardRes.status).toBe(200);
    const row = (boardRes.body.data as Array<{ productId: string }>).find(
      (r) => r.productId === productId,
    );
    expect(row).toBeDefined();
    expect(row!.ladderCount).toBeGreaterThanOrEqual(1);

    const detailRes = await request(app)
      .get(`/api/v1/staff/sales/board/${productId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.ladder.length).toBeGreaterThanOrEqual(1);
    expect(detailRes.body.data.ladder[0].ratePaise).toBeGreaterThan(0);
    const raw = JSON.stringify(detailRes.body).toLowerCase();
    expect(raw).not.toContain('sellerid');
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/board')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });

  // Regression — B-27 ("demand" showed a raw truncated buyer id, never the
  // firm behind it).
  it('resolves the buyer firm on demand against a product, not just his id', async () => {
    const sales = await staffToken(app, 'sales');
    const { productId } = await seedLiveListingLine();
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyer = await Buyer.findById(buyerId);
    const counterparty = await Counterparty.findById(buyer!.counterpartyId);
    await Ask.create({
      buyerId,
      productId,
      qty: 5,
      conditionRequirement: { expiryBand: 'over12' },
      visibleToAllAt: new Date(),
      state: 'open',
      ttlAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const detailRes = await request(app)
      .get(`/api/v1/staff/sales/board/${productId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(detailRes.status).toBe(200);
    const ask = (
      detailRes.body.data.openAsks as Array<{ buyerId: string; buyerFirm: string }>
    ).find((a) => a.buyerId === buyerId);
    expect(ask).toBeDefined();
    expect(ask!.buyerFirm).toBe(counterparty!.firm);
  });
});

describe('GET /staff/sales/pools, /staff/sales/pools/:poolId', () => {
  it('lists a pool with its commitment and computed quantities', async () => {
    const sales = await staffToken(app, 'sales');
    const { poolId, buyerId } = await seedPoolWithCommitment();

    const listRes = await request(app)
      .get('/api/v1/staff/sales/pools')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body.data as Array<{ poolId: string }>).find((p) => p.poolId === poolId);
    expect(row).toBeDefined();
    expect(row!.committedQty).toBe(5);

    const detailRes = await request(app)
      .get(`/api/v1/staff/sales/pools/${poolId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.commitments).toHaveLength(1);
    expect(detailRes.body.data.commitments[0].buyerId).toBe(buyerId);
  });

  it('404s for an unknown pool', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await request(app)
      .get('/api/v1/staff/sales/pools/000000000000000000000000')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(res.status).toBe(404);
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/pools')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });

  // Regression — B-41 ("NaN of 200 boxes"). One commitment with a
  // missing/non-numeric `qty` — the schema requires it, so this can only
  // happen via stale data or a write outside Mongoose's validation, which is
  // exactly why the raw driver is used here instead of `.create()` — poisoned
  // the running sum, since `n + undefined` is `NaN` and every further
  // addition to a `NaN` stays `NaN`.
  it('a commitment with a missing qty does not turn the pool total into NaN', async () => {
    const { poolId } = await seedPoolWithCommitment();
    await PoolCommitment.collection.insertOne({
      poolId: new Types.ObjectId(poolId),
      buyerId: new Types.ObjectId(),
      deliveryLocationId: new Types.ObjectId(),
      isBinding: false,
      withdrawnAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      // `qty` deliberately omitted.
    });

    const sales = await staffToken(app, 'sales');
    const detailRes = await request(app)
      .get(`/api/v1/staff/sales/pools/${poolId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(detailRes.status).toBe(200);
    expect(Number.isNaN(detailRes.body.data.committedQty)).toBe(false);
    expect(detailRes.body.data.committedQty).toBe(5); // the one well-formed commitment, unpoisoned.
  });
});

describe('GET /staff/sales/buyers, /staff/sales/buyers/:buyerId', () => {
  it('lists buyers and reads one buyer file', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);

    const listRes = await request(app)
      .get('/api/v1/staff/sales/buyers')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(listRes.status).toBe(200);
    expect(
      (listRes.body.data as Array<{ buyerId: string }>).some((b) => b.buyerId === buyerId),
    ).toBe(true);

    const fileRes = await request(app)
      .get(`/api/v1/staff/sales/buyers/${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.data.buyerId).toBe(buyerId);
    expect(Array.isArray(fileRes.body.data.orders)).toBe(true);
    expect(Array.isArray(fileRes.body.data.callLogs)).toBe(true);
  });

  it('404s for an unknown buyer', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await request(app)
      .get('/api/v1/staff/sales/buyers/000000000000000000000000')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(res.status).toBe(404);
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/buyers')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });

  // Regression — B-29/B-43/B-44 ("Buyers only." on every proxy call from the
  // Sales call workspace, however the SKU was entered). The buyer file's own
  // `buyerId` is the `Buyer` document's `_id`; every proxy endpoint
  // (`requireActiveBuyer`) keys on `Buyer.counterpartyId` instead — a
  // different id in a different collection. `SalesCallWorkspacePage.tsx` was
  // sending `buyerId` where the proxy calls needed `counterpartyId`, which
  // guaranteed the lookup found nothing. This asserts the buyer file exposes
  // the real `counterpartyId` — the field the frontend fix now reads instead.
  it('the buyer file exposes counterpartyId, distinct from buyerId, matching the real Buyer document', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyer = await Buyer.findById(buyerId);

    const fileRes = await request(app)
      .get(`/api/v1/staff/sales/buyers/${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.data.counterpartyId).toBe(buyer!.counterpartyId.toString());
    expect(fileRes.body.data.counterpartyId).not.toBe(buyerId);
  });

  // Regression — "what he buys" showed only an order count, never what he
  // last paid (BR-045: an order line's `ratePaise` is frozen, never
  // re-derived, so the latest order's own line is exactly "what he paid").
  it("surfaces the buyer's last-paid rate per product, from his most recent order", async () => {
    const sales = await staffToken(app, 'sales');
    const { buyerId, soId, skuId } = await seedSoWithLine();
    const sku = await Sku.findById(skuId);

    const fileRes = await request(app)
      .get(`/api/v1/staff/sales/buyers/${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    expect(fileRes.status).toBe(200);
    const row = (
      fileRes.body.data.productHistory as Array<{
        productId: string;
        lastPaidRatePaise: number | null;
      }>
    ).find((p) => p.productId === sku!.productId.toString());
    expect(row).toBeDefined();
    expect(row!.lastPaidRatePaise).toBe(1000); // seedSoWithLine's SoLine.ratePaise

    // Sanity on the fixture itself, so a future change to seedSoWithLine
    // can't silently make this assertion meaningless.
    expect(soId).toBeTruthy();
  });
});

describe('GET /staff/sales/orders', () => {
  it('lists a seeded live order, with no seller identity anywhere in the response', async () => {
    const sales = await staffToken(app, 'sales');
    const { soId } = await seedSoWithLine();

    const res = await request(app)
      .get('/api/v1/staff/sales/orders?tab=live')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(res.status).toBe(200);
    const row = (
      res.body.data as Array<{
        soId: string;
        buyerId: string;
        buyerCounterpartyId: string;
        upcomingReceiptId: string | null;
      }>
    ).find((r) => r.soId === soId);
    expect(row).toBeDefined();
    expect(typeof row?.buyerId).toBe('string');
    expect(typeof row?.buyerCounterpartyId).toBe('string');
    expect(row?.upcomingReceiptId).toBeNull();
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain('sellerid');
    expect(raw).not.toContain('sellernet');
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/orders')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });

  // Regression — the prototype's 7-step progress strip already exists as
  // `chain.stage` (BR-030/031); this just confirms it's actually joined
  // through onto the order row, at the state a freshly-created chain starts at.
  it("surfaces the order's chain.stage as chainStage", async () => {
    const sales = await staffToken(app, 'sales');
    const { soId } = await seedSoWithLine();

    const res = await request(app)
      .get('/api/v1/staff/sales/orders?tab=live')
      .set('Authorization', `Bearer ${sales.token}`);
    const row = (res.body.data as Array<{ soId: string; chainStage: string }>).find(
      (r) => r.soId === soId,
    );
    expect(row).toBeDefined();
    expect(row!.chainStage).toBe('so'); // Chain.create's own default.
  });
});

describe('GET /staff/sales/funnel', () => {
  it('returns the nine-stage report shape', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await request(app)
      .get('/api/v1/staff/sales/funnel')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.metrics).toHaveLength(9);
    expect(res.body.data.metrics.map((m: { key: string }) => m.key)).toEqual([
      'registered',
      'classified',
      'viewing',
      'asked',
      'rate_held',
      'took_it',
      'paid',
      'delivered',
      'ordered_again',
    ]);
  });

  it('a role without SALES_WORKLIST_READ is refused', async () => {
    const logistics = await staffToken(app, 'transport_logistics');
    const res = await request(app)
      .get('/api/v1/staff/sales/funnel')
      .set('Authorization', `Bearer ${logistics.token}`);
    expect(res.status).toBe(403);
  });
});
