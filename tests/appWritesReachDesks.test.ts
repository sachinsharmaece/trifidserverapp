import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Seller } from '../src/models/Seller.js';
import { Buyer } from '../src/models/Buyer.js';
import { Sku } from '../src/models/Sku.js';
import { Ask } from '../src/models/Ask.js';
import { Quote } from '../src/models/Quote.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { MspRequest } from '../src/models/MspRequest.js';
import { BuyerLocation } from '../src/models/BuyerLocation.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';
import { findWallViolations, type Identity } from './wallSweepRules.js';

/**
 * What the buyer app and the seller app WRITE, and whether the admin Sales and Purchase
 * desks READ it. Writes go through the endpoints the two apps call; the desks are read with
 * GET only, and every desk read is checked to leave the database exactly as it found it.
 */

const app = createApp();

function tokenFor(counterpartyId: string): string {
  return signAccessToken({
    sub: counterpartyId,
    actorType: 'counterparty',
    counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}
const get = (token: string, path: string) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
const post = (token: string, path: string, body: object, idem = false) => {
  const r = request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  if (idem) r.set('Idempotency-Key', `app-${Date.now()}-${Math.random()}`);
  return r.send(body);
};

async function identityOf(counterpartyId: string, docId: string): Promise<Identity> {
  const cp = await Counterparty.findById(counterpartyId);
  return {
    ids: [docId, counterpartyId],
    strings: [cp!.firm, cp!.gstin, cp!.mobile].filter((s): s is string => !!s),
  };
}

async function world() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const tehsil = await createTehsil();

  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const seller = await Seller.findById(sellerDocId);
  const sellerCp = String(seller!.counterpartyId);
  const sellerToken = tokenFor(sellerCp);

  const buyerDocId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
  const buyer = await Buyer.findById(buyerDocId);
  const buyerCp = String(buyer!.counterpartyId);
  const buyerToken = tokenFor(buyerCp);

  const skuId = await createTestSku('Medium');
  const productId = String((await Sku.findById(skuId))!.productId);
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.03, admin.employeeId);
  }

  const listing = await post(sellerToken, '/listings', {
    productId,
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise: 40000,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '48h',
        provenance: 'company',
        qty: 100,
      },
    ],
  });
  expect(listing.status).toBe(201);
  const lineId = (listing.body.data as { lineIds: string[] }).lineIds[0]!;

  return {
    sales,
    purchase,
    sellerDocId,
    sellerCp,
    sellerToken,
    buyerDocId,
    buyerCp,
    buyerToken,
    skuId,
    productId,
    lineId,
    wall: {
      identities: {
        buyer: await identityOf(buyerCp, buyerDocId),
        seller: await identityOf(sellerCp, sellerDocId),
      },
      soTotalPaise: -1,
    },
  };
}

async function snapshotCounts(): Promise<Record<string, number>> {
  return {
    ask: await Ask.countDocuments(),
    quote: await Quote.countDocuments(),
    pile: await Pile.countDocuments(),
    pileRequest: await PileRequest.countDocuments(),
    listing: await Listing.countDocuments(),
    line: await ListingLine.countDocuments(),
    msp: await MspRequest.countDocuments(),
  };
}

describe('seller app writes reach the Purchase and Sales desks, read-only', () => {
  it("a seller listing shows on Purchase (seller file, supply) and on the Sales board and the buyer's own board", async () => {
    const w = await world();

    const sellerFile = await get(w.purchase.token, `/staff/purchase/sellers/${w.sellerDocId}/file`);
    expect(sellerFile.status).toBe(200);
    expect(JSON.stringify(sellerFile.body.data)).toContain(w.skuId);

    const products = await get(w.sales.token, '/staff/sales/board');
    expect((products.body.data as Array<{ productId: string }>).map((p) => p.productId)).toContain(
      w.productId,
    );

    const forHim = await get(w.sales.token, `/staff/sales/buyers/${w.buyerDocId}/board`);
    expect((forHim.body.data as Array<{ productId: string }>).map((p) => p.productId)).toContain(
      w.productId,
    );
    // Sales sees the buyer's rate, never the seller's net, never the seller.
    expect(findWallViolations('sales', products.body, w.wall)).toEqual([]);
    expect(findWallViolations('sales', forHim.body, w.wall)).toEqual([]);
  });

  it("a seller's quote on an app ask shows on Purchase (states, gaps) and on Sales (He asked → Rate held)", async () => {
    const w = await world();
    const ask = await post(w.buyerToken, '/asks', {
      skuId: w.skuId,
      allPacks: false,
      qty: 5,
      conditionRequirement: { expiryBand: 'over12' },
    });
    expect(ask.status).toBe(201);
    const askId = ask.body.data.askId as string;

    const quote = await post(w.sellerToken, `/asks/${askId}/quotes`, {
      ratePaiseForIndore: 39000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '48h',
      provenance: 'company',
      daysToIndore: 1,
    });
    expect(quote.status).toBe(201);

    const before = await snapshotCounts();

    // Purchase: the ask now has a quoted seller; the per-ask states list him as `quoted`.
    const demand = await get(w.purchase.token, '/staff/purchase/demand');
    const row = (
      demand.body.data as Array<{ askId: string; sellerCounts: { quoted: number } }>
    ).find((r) => r.askId === askId);
    expect(row?.sellerCounts.quoted).toBe(1);
    const states = await get(w.purchase.token, `/staff/purchase/asks/${askId}/seller-states`);
    expect(
      (states.body.data as Array<{ sellerId: string; state: string }>).find(
        (s) => s.sellerId === w.sellerDocId,
      )?.state,
    ).toBe('quoted');
    const gaps = await get(w.purchase.token, `/staff/purchase/asks/${askId}/quote-gaps`);
    expect(gaps.status).toBe(200);
    expect(gaps.body.data).toHaveLength(1);

    // Sales: the buyer's ask is now `quoted` on his file, and the funnel counts a held rate.
    const file = await get(w.sales.token, `/staff/sales/buyers/${w.buyerDocId}`);
    expect(
      (file.body.data.openAsks as Array<{ askId: string; state: string }>).find(
        (a) => a.askId === askId,
      )?.state,
    ).toBe('quoted');
    const funnel = await get(w.sales.token, '/staff/sales/funnel');
    const held = (funnel.body.data.metrics as Array<{ key: string; value: number }>).find(
      (m) => m.key === 'rate_held',
    );
    expect(held!.value).toBeGreaterThanOrEqual(1);

    // The wall on what Purchase and Sales just read.
    expect(findWallViolations('purchase', demand.body, w.wall)).toEqual([]);
    expect(findWallViolations('sales', file.body, w.wall)).toEqual([]);

    // Read-only: reading changed nothing.
    expect(await snapshotCounts()).toEqual(before);
  });
});

describe('buyer app writes reach the desks, read-only', () => {
  it("a buy request on a listing line (the pile) shows on Purchase's confirmations queue with a buyer count and no buyer identity", async () => {
    const w = await world();
    const location = await BuyerLocation.create({
      buyerId: w.buyerDocId,
      label: 'Warehouse',
      address: 'Test address',
      pin: '452001',
      licenceNo: 'LIC-X',
      approvedBy: w.sales.employeeId,
      approvedAt: new Date(),
      isPrimary: true,
    });
    const inquire = await post(
      w.buyerToken,
      `/listings/lines/${w.lineId}/inquire`,
      { qty: 10, deliveryLocationId: String(location._id) },
      true,
    );
    expect(inquire.status).toBe(201);
    const pileId = inquire.body.data.pileId as string;

    const before = await snapshotCounts();
    const piles = await get(w.purchase.token, '/staff/purchase/piles');
    expect(piles.status).toBe(200);
    const item = (piles.body.data as Array<{ pileId: string; boxes: number; buyers: number }>).find(
      (p) => p.pileId === pileId,
    );
    expect(item).toBeDefined();
    expect(item!.boxes).toBe(10);
    expect(item!.buyers).toBe(1);
    expect(findWallViolations('purchase', piles.body, w.wall)).toEqual([]);
    expect(await snapshotCounts()).toEqual(before);
  });

  it("a buyer's rate request (MSP) shows on Sales' MSP queue", async () => {
    const w = await world();
    const msp = await post(w.buyerToken, '/me/msp-requests', { skuId: w.skuId, qty: 3 });
    expect(msp.status).toBe(201);

    const queue = await get(w.sales.token, '/staff/sales/msp');
    expect(queue.status).toBe(200);
    expect(
      (queue.body.data as Array<{ skuId: string; qty: number }>).some(
        (r) => r.skuId === w.skuId && r.qty === 3,
      ),
    ).toBe(true);
  });

  it('every Sales and Purchase desk read refuses a write: GET routes only, and a POST to a read path is not a route', async () => {
    const w = await world();
    for (const path of [
      '/staff/purchase/demand',
      '/staff/sales/worklist',
      '/staff/sales/buyers',
      '/staff/sales/funnel',
    ]) {
      const res = await post(w.sales.token, path, {});
      expect([404, 405]).toContain(res.status);
    }
  });
});
