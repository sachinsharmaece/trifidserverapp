import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Sku } from '../src/models/Sku.js';
import { Seller } from '../src/models/Seller.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Po } from '../src/models/Po.js';
import * as catalogService from '../src/modules/catalog/catalog.service.js';
import * as purchaseService from '../src/modules/desk/purchase/purchase.service.js';
import { staffToken, createTestSku } from './m4helpers.js';
import {
  createTehsil,
  createApprovedSellerAtTehsils,
  createApprovedBuyerAtTehsil,
} from './m5helpers.js';

const app = createApp();

async function makeSeller(purchaseToken: string): Promise<string> {
  const tehsil = await createTehsil();
  return createApprovedSellerAtTehsils(app, purchaseToken, [tehsil]);
}

describe('Purchase-desk v2 — the seller catalogue', () => {
  it('adds a catalogue entry, then reads it back with pack detail and listed state', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('B');
    const sku = await Sku.findById(skuId);

    const addRes = await request(app)
      .post('/api/v1/staff/purchase/catalogue')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ sellerId, productId: sku!.productId.toString(), skuIds: [skuId] });
    expect(addRes.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/v1/staff/purchase/sellers/${sellerId}/catalogue`)
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(listRes.status).toBe(200);
    const [entry] = listRes.body.data as Array<{
      productId: string;
      packsDetailed: boolean;
      packs: Array<{ skuId: string; listed: boolean }>;
    }>;
    expect(entry.productId).toBe(sku!.productId.toString());
    expect(entry.packsDetailed).toBe(true);
    expect(entry.packs[0]!.skuId).toBe(skuId);
    expect(entry.packs[0]!.listed).toBe(false); // Capability only — nothing priced yet.
  });

  it('upserts in place rather than duplicating a second row for the same seller/product', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('B');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    await request(app)
      .post('/api/v1/staff/purchase/catalogue')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ sellerId, productId, skuIds: [] });
    await request(app)
      .post('/api/v1/staff/purchase/catalogue')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ sellerId, productId, skuIds: [skuId] });

    const { SellerCatalogueEntry } = await import('../src/models/SellerCatalogueEntry.js');
    const rows = await SellerCatalogueEntry.find({ sellerId, productId });
    expect(rows.length).toBe(1);
    expect(rows[0]!.skuIds.length).toBe(1);
  });
});

describe('Purchase-desk v2 — draft masters (LOCK-26-style)', () => {
  it('a draft company/product/pack works in a catalogue entry but cannot back a live listing until Admin confirms it', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);

    const { manufacturerId } = await catalogService.createManufacturerDraft(
      `Draft Mfr ${Date.now()}`,
      purchase.employeeId,
    );
    const { productId } = await catalogService.createProductDraft(
      {
        brand: `Draft Brand ${Date.now()}`,
        technical: 'Test Technical',
        manufacturerId,
        hsn: '3808',
      },
      purchase.employeeId,
    );
    const { skuId } = await catalogService.createSkuDraft(
      { productId, packLabel: '1 KG', packSize: 1, baseUnit: 'KG', unitsPerBox: 10 },
      purchase.employeeId,
    );

    // Usable in the catalogue immediately — the call is never blocked.
    const catRes = await request(app)
      .post('/api/v1/staff/purchase/catalogue')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ sellerId, productId, skuIds: [skuId] });
    expect(catRes.status).toBe(201);

    // Shows up on the drafts panel.
    const drafts = await request(app)
      .get('/api/v1/staff/purchase/masters/drafts')
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(drafts.status).toBe(200);
    const kinds = (drafts.body.data as Array<{ kind: string; id: string }>).map(
      (d) => d.kind + ':' + d.id,
    );
    expect(kinds).toContain(`manufacturer:${manufacturerId}`);
    expect(kinds).toContain(`product:${productId}`);
    expect(kinds).toContain(`sku:${skuId}`);

    // Cannot back a live listing yet — the same guard fires whether the
    // seller lists it himself or Purchase enters it on his behalf.
    const seller = await Seller.findById(sellerId);
    const counterparty = seller!.counterpartyId.toString();
    const refusedRes = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        sellerCounterpartyId: counterparty,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 50000,
            expiryBand: 'over12',
            deliveryBand: '48h',
            provenance: 'company',
            qty: 10,
          },
        ],
        callNote: 'Called 24 Sep, walked him through it.',
      });
    expect(refusedRes.status).toBe(400);

    // Admin confirms the whole chain.
    await catalogService.updateManufacturer(manufacturerId, { state: 'live' });
    await catalogService.updateProduct(productId, { state: 'live' });
    await catalogService.updateSku(skuId, { state: 'live' });

    const acceptedRes = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        sellerCounterpartyId: counterparty,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 50000,
            expiryBand: 'over12',
            deliveryBand: '48h',
            provenance: 'company',
            qty: 10,
          },
        ],
        callNote: 'Called 24 Sep, walked him through it.',
      });
    expect(acceptedRes.status).toBe(201);

    // The desk-authored line carries the staff's own words — surfaced
    // through proxyLog, no separate `origin`/`authorityNote` field needed.
    const { lineIds } = acceptedRes.body.data as { lineIds: string[] };
    const line = await ListingLine.findById(lineIds[0]);
    expect(line!.proxyLog.length).toBe(1);
    expect(line!.proxyLog[0]!.callNote).toContain('Called 24 Sep');
  });

  it('refuses a caller without catalog:draft_create', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await request(app)
      .post('/api/v1/staff/purchase/masters/manufacturers')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ name: 'Should not work' });
    expect(res.status).toBe(403);
  });
});

describe('Purchase-desk v2 — supply matrix', () => {
  it('counts sellers who carry a product separately from sellers with a live listing on it', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerA = await makeSeller(purchase.token);
    const sellerB = await makeSeller(purchase.token);
    const skuId = await createTestSku('B');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    // Both carry it; only A has it on the board.
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId: sellerA, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId: sellerB, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );
    const listing = await Listing.create({
      sellerId: sellerA,
      productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId,
      ratePaise: 40000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 50,
    });

    const byProduct = await purchaseService.getSupplyMatrixByProduct();
    const row = byProduct.find((r) => r.productId === productId);
    expect(row!.carryCount).toBe(2);
    expect(row!.listedCount).toBe(1);

    const bySeller = await purchaseService.getSupplyMatrixBySeller();
    const rowA = bySeller.find((r) => r.sellerId === sellerA);
    const rowB = bySeller.find((r) => r.sellerId === sellerB);
    expect(rowA!.carryCount).toBe(1);
    expect(rowA!.listedCount).toBe(1);
    expect(rowB!.carryCount).toBe(1);
    expect(rowB!.listedCount).toBe(0);
  });
});

describe('Purchase-desk v2 — dispatch chase queue', () => {
  it('buckets a PO as overdue once its dispatch due date has passed', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const { So } = await import('../src/models/So.js');
    const { Chain } = await import('../src/models/Chain.js');
    const chain = await Chain.create({ chainNo: `CH-TEST-${Date.now()}`, source: 'inquiry' });
    const so = await So.create({
      soNo: `SO-TEST-${Date.now()}`,
      chainId: chain._id,
      buyerId: sellerId, // placeholder ref — the dispatch queue reads only Po fields.
      sellerId,
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'po_released',
      payDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      totalPaise: 100000,
    });
    const po = await Po.create({
      poNo: `PO-TEST-${Date.now()}`,
      chainId: chain._id,
      soId: so._id,
      sellerId,
      state: 'released',
      dispatchDueDate: new Date(Date.now() - 60 * 60 * 1000), // an hour ago.
      promisedOutOfIndoreBy: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const queue = await purchaseService.getDispatchChaseQueue();
    const row = queue.find((r) => r.poId === (po._id as { toString(): string }).toString());
    expect(row).toBeTruthy();
    expect(row!.bucket).toBe('overdue');
    expect(row!.hoursLeft).toBeLessThan(0);
  });
});

describe('Purchase-desk v2 — the seller file', () => {
  it('combines area, scorecard, catalogue and listings into one read, no buyer field anywhere', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('B');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );

    const file = await purchaseService.getSellerFile(sellerId);
    expect(file.area.length).toBe(1);
    expect(file.catalogue.length).toBe(1);
    expect(file.scorecard.trustTier).toBeTruthy();
    expect(JSON.stringify(file)).not.toMatch(/buyer/i);
  });
});

describe('Purchase-desk v2 — per-ask seller states and the product funnel', () => {
  it('walks a seller through carries → listed → quoted, in the prototype’s own vocabulary', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const sellerId = await makeSeller(purchase.token);
    const seller = await Seller.findById(sellerId);
    const sellerCounterpartyId = seller!.counterpartyId.toString();
    const skuId = await createTestSku('B');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    const tehsil = await createTehsil();
    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const { Buyer } = await import('../src/models/Buyer.js');
    const buyer = await Buyer.findById(buyerId);
    const demandService = await import('../src/modules/demand/demand.service.js');

    const { askId } = await demandService.raiseAsk(
      (buyer!.counterpartyId as unknown as string).toString(),
      { skuId, allPacks: false, qty: 5, conditionRequirement: { expiryBand: 'over12' } },
    );

    // Carries — in the catalogue, nothing priced yet.
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );
    let states = await purchaseService.getAskSellerStates(askId);
    expect(states).toEqual([
      expect.objectContaining({ sellerId, state: 'carries', ratePaise: null }),
    ]);

    let file = await purchaseService.getSellerFile(sellerId);
    expect(file.openDemand.map((d) => d.askId)).toContain(askId);

    // Listed — a live rate on the board, still hasn't answered this ask.
    const listing = await Listing.create({
      sellerId,
      productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId,
      ratePaise: 42000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 20,
    });
    states = await purchaseService.getAskSellerStates(askId);
    expect(states[0]).toMatchObject({ sellerId, state: 'listed', ratePaise: 42000 });

    // Quoted — answered this ask directly.
    await demandService.postQuote(sellerCounterpartyId, askId, {
      ratePaiseForIndore: 41000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '2-5d',
      provenance: 'company',
      daysToIndore: 2,
    });
    states = await purchaseService.getAskSellerStates(askId);
    expect(states[0]).toMatchObject({ sellerId, state: 'quoted', ratePaise: 41000 });

    // Once quoted, the ask drops off "open demand he could serve".
    file = await purchaseService.getSellerFile(sellerId);
    expect(file.openDemand.map((d) => d.askId)).not.toContain(askId);

    // The product funnel counts this ask as an inquiry and as quoted.
    const funnel = await purchaseService.getProductFunnel(productId);
    expect(funnel.inq).toBeGreaterThanOrEqual(1);
    expect(funnel.quoted).toBeGreaterThanOrEqual(1);
    expect(funnel.sellerCount).toBeGreaterThanOrEqual(1);
  });
});
