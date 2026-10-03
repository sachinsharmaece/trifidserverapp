import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { Sku } from '../src/models/Sku.js';
import { Seller } from '../src/models/Seller.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Po } from '../src/models/Po.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { AuditLog } from '../src/models/AuditLog.js';
import * as catalogService from '../src/modules/catalog/catalog.service.js';
import * as purchaseService from '../src/modules/desk/purchase/purchase.service.js';
import { staffToken, createTestSku } from './m4helpers.js';
import {
  createTehsil,
  createApprovedSellerAtTehsils,
  createApprovedBuyerAtTehsil,
} from './m5helpers.js';
import { randomGstin, randomMobile } from './helpers.js';

const app = createApp();

async function makeSeller(purchaseToken: string): Promise<string> {
  const tehsil = await createTehsil();
  return createApprovedSellerAtTehsils(app, purchaseToken, [tehsil]);
}

// Every call needs its own fresh, checksum-valid GSTIN and mobile — reusing
// a fixed one across calls would collide with `assertGstinAndMobileAreFree`
// and fail for the wrong reason.
async function baseSellerRegistrationBody(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    mobile: randomMobile(),
    firm: `Test Seller ${Date.now()}-${Math.random()}`,
    gstin: await randomGstin(),
    ownerName: 'Owner Name',
    licenceNo: 'MP/IND/INS/2016/0771',
    references: [
      { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Reliable' },
      { firm: 'Ref Two', phone: '9000000002', relationship: 'Supplier', whatTheySaid: 'Reliable' },
    ],
    bankDetail: {
      accountNumber: '000900012345678',
      ifsc: 'HDFC0001234',
      accountName: 'Owner Name',
    },
    consent: { noticeVersion: 'v1', marketingOptIn: false },
    callNote: 'Called on 27 Sep, confirmed everything.',
    ...overrides,
  };
}

describe('QA fixes — parity audit, 2026-09-27', () => {
  it('rejects a referee phone that is not a real 10-digit mobile number', async () => {
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(
        await baseSellerRegistrationBody({
          references: [
            { firm: 'Ref One', phone: '123', relationship: 'Supplier', whatTheySaid: 'Reliable' },
            { firm: 'Ref Two', phone: '456', relationship: 'Supplier', whatTheySaid: 'Reliable' },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // Both bad phones are reported at once, not just the first — the whole
    // point of the "only one error shows at a time" fix.
    const fields = (res.body.error.fieldErrors as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toContain('references.0.phone');
    expect(fields).toContain('references.1.phone');
  });

  it('rejects a bare "LIC" licence number but accepts a real-shaped one', async () => {
    const purchase = await staffToken(app, 'purchase');
    const badRes = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(await baseSellerRegistrationBody({ licenceNo: 'LIC' }));
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.field ?? (badRes.body.error.fieldErrors?.[0]?.field as string)).toBe(
      'licenceNo',
    );

    const goodRes = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(await baseSellerRegistrationBody());
    expect(goodRes.status).toBe(201);
  });

  it('flags an account name that does not resemble the owner or firm, without blocking registration', async () => {
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(
        await baseSellerRegistrationBody({
          ownerName: 'Dinesh Maheshwari',
          firm: 'Maheshwari Agro Agencies',
          bankDetail: {
            accountNumber: '000900012345678',
            ifsc: 'HDFC0001234',
            accountName: 'Someone Else Entirely',
          },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.data.accountNameWarning).toBeTruthy();
    expect(res.body.data.accountNameWarning as string).toContain('Someone Else Entirely');
  });

  it('does not warn when the account name reasonably matches the owner or firm', async () => {
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(
        await baseSellerRegistrationBody({
          ownerName: 'Dinesh Maheshwari',
          firm: 'Maheshwari Agro Agencies',
          bankDetail: {
            accountNumber: '000900012345678',
            ifsc: 'HDFC0001234',
            accountName: 'Dinesh Maheshwari',
          },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.data.accountNameWarning).toBeNull();
  });

  it('blocks a case-insensitive duplicate company', async () => {
    const purchase = await staffToken(app, 'purchase');
    const name = `Syngenta-${Date.now()}`;
    const first = await request(app)
      .post('/api/v1/staff/purchase/masters/manufacturers')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ name });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/staff/purchase/masters/manufacturers')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ name: name.toLowerCase() });
    expect(second.status).toBe(400);
    expect(second.body.error.field).toBe('name');
  });

  it('rejects an invalid HSN and a pack label that does not match its base unit, on a draft product/pack', async () => {
    const purchase = await staffToken(app, 'purchase');
    const { manufacturerId } = await catalogService.createManufacturerDraft(
      `Mfr-${Date.now()}`,
      purchase.employeeId,
    );

    const badHsn = await request(app)
      .post('/api/v1/staff/purchase/masters/products')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ brand: `Brand-${Date.now()}`, technical: 'Test', manufacturerId, hsn: 'ABC' });
    expect(badHsn.status).toBe(400);

    const { productId } = await catalogService.createProductDraft(
      { brand: `Brand-${Date.now()}`, technical: 'Test', manufacturerId, hsn: '38089199' },
      purchase.employeeId,
    );

    const mismatchedPack = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ productId, packLabel: '500 GM', packSize: 0.5, baseUnit: 'LTR', unitsPerBox: 12 });
    expect(mismatchedPack.status).toBe(400);
  });

  it('gives a friendly message on a duplicate pack instead of a 500', async () => {
    const purchase = await staffToken(app, 'purchase');
    const { manufacturerId } = await catalogService.createManufacturerDraft(
      `Mfr-${Date.now()}`,
      purchase.employeeId,
    );
    const { productId } = await catalogService.createProductDraft(
      { brand: `Brand-${Date.now()}`, technical: 'Test', manufacturerId, hsn: '38089199' },
      purchase.employeeId,
    );

    const input = {
      productId,
      packLabel: '1 LTR',
      packSize: 1,
      baseUnit: 'LTR' as const,
      unitsPerBox: 20,
    };
    const first = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(input);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(input);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('VALIDATION_FAILED');
    expect(second.body.error.message_en).toContain('already exists');
  });

  it('the demand and dispatch/confirmations/recovery reads carry readable names, not bare seller-id hashes', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );
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
      ratePaise: 40000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 10,
    });

    const demand = await purchaseService.getActiveDemandList({});
    for (const item of demand) {
      expect(item).toHaveProperty('brand');
      expect(item).toHaveProperty('technical');
    }

    const dispatchQueue = await purchaseService.getDispatchChaseQueue();
    for (const row of dispatchQueue) {
      expect(row).toHaveProperty('sellerFirm');
    }
  });
});

describe('Purchase-desk v2 — the seller catalogue', () => {
  it('adds a catalogue entry, then reads it back with pack detail and listed state', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
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
    const skuId = await createTestSku('Medium');
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

  // Regression — B-22: `listProducts`/`listSkusForProduct` feed every
  // technical→product→pack picker (counterparty and staff-proxy). A draft
  // "cannot back a live listing until Admin confirms it", so it should
  // never even be offered as a choice there — unlike `listAllProducts`,
  // the Manage desk's own unfiltered review list, which is untouched.
  it('excludes a draft product/SKU from the technical→product→pack picker', async () => {
    const purchase = await staffToken(app, 'purchase');
    const technical = `Draft Technical ${Date.now()}-${Math.random()}`;
    const draftProductRes = await request(app)
      .post('/api/v1/staff/purchase/masters/products')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        brand: `Draft Brand ${Date.now()}`,
        technical,
        manufacturerId: (
          await catalogService.createManufacturer(`Draft Mfr ${Date.now()}-${Math.random()}`)
        ).manufacturerId,
        hsn: '38089110',
      });
    expect(draftProductRes.status).toBe(201);
    const productId = draftProductRes.body.data.productId as string;

    const pickerRes = await request(app)
      .get(`/api/v1/catalog/products?technical=${encodeURIComponent(technical)}`)
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(pickerRes.status).toBe(200);
    expect(
      (pickerRes.body.data as Array<{ productId: string }>).some((p) => p.productId === productId),
    ).toBe(false);

    await catalogService.updateProduct(productId, { state: 'live' });
    const pickerAfterConfirm = await request(app)
      .get(`/api/v1/catalog/products?technical=${encodeURIComponent(technical)}`)
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(
      (pickerAfterConfirm.body.data as Array<{ productId: string }>).some(
        (p) => p.productId === productId,
      ),
    ).toBe(true);
  });
});

describe('Purchase-desk v2 — supply matrix', () => {
  it('counts sellers who carry a product separately from sellers with a live listing on it', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerA = await makeSeller(purchase.token);
    const sellerB = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
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

  // Regression — B-04: the products' Analysis tab (`getProductFunnel`'s
  // `sellerCount`) used its own separately-written `countDocuments` query;
  // both now read the same shared `computeSellerCatalogueCoverage`, so they
  // can no longer drift apart the way the ticket described.
  it("getProductFunnel's sellerCount agrees with the Supply Matrix's carryCount for the same product", async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerA = await makeSeller(purchase.token);
    const sellerB = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId: sellerA, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId: sellerB, productId, skuIds: [skuId] },
      { employeeId: purchase.employeeId },
    );

    const byProduct = await purchaseService.getSupplyMatrixByProduct();
    const matrixRow = byProduct.find((r) => r.productId === productId);
    const funnelRow = await purchaseService.getProductFunnel(productId);
    expect(funnelRow.sellerCount).toBe(matrixRow!.carryCount);
    expect(funnelRow.sellerCount).toBe(2);
  });

  // Feature-gap session, 2026-10-01 — the Supply Matrix diff tab wanted a
  // Class A/B/C column; `Product.class` (BR-040) already exists, this just
  // confirms it's actually joined through onto the matrix row.
  it("surfaces the product's class (BR-040) on the Product×Seller row", async () => {
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();
    const { Product } = await import('../src/models/Product.js');
    const product = await Product.findById(productId);

    const byProduct = await purchaseService.getSupplyMatrixByProduct();
    const row = byProduct.find((r) => r.productId === productId);
    expect(row!.class).toBe(product!.class);
  });
});

describe('Purchase-desk v2 — supply matrix call list', () => {
  it('lists a seller who is listed but has not quoted an open ask, and drops him once he quotes', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const sellerId = await makeSeller(purchase.token);
    const seller = await Seller.findById(sellerId);
    const sellerCounterpartyId = seller!.counterpartyId.toString();
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

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
      ratePaise: 40000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 10,
    });

    const tehsil = await createTehsil();
    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const { Buyer } = await import('../src/models/Buyer.js');
    const buyer = await Buyer.findById(buyerId);
    const demandService = await import('../src/modules/demand/demand.service.js');
    const { askId } = await demandService.raiseAsk(
      (buyer!.counterpartyId as unknown as string).toString(),
      { skuId, allPacks: false, qty: 5, conditionRequirement: { expiryBand: 'over12' } },
    );

    let callList = await purchaseService.getSupplyMatrixCallList(productId);
    expect(callList).toEqual([
      expect.objectContaining({ sellerId, state: 'listed', ratePaise: 40000 }),
    ]);

    await demandService.postQuote(sellerCounterpartyId, askId, {
      ratePaiseForIndore: 41000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '2-5d',
      provenance: 'company',
      daysToIndore: 2,
    });

    callList = await purchaseService.getSupplyMatrixCallList(productId);
    expect(callList).toEqual([]);
  });
});

describe("Purchase-desk v2 — Today's on-board-not-quoted queue", () => {
  it('surfaces an ask with a listed-but-silent seller, and drops it once he quotes', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const sellerId = await makeSeller(purchase.token);
    const seller = await Seller.findById(sellerId);
    const sellerCounterpartyId = seller!.counterpartyId.toString();
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

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
      ratePaise: 40000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 10,
    });

    const tehsil = await createTehsil();
    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const { Buyer } = await import('../src/models/Buyer.js');
    const buyer = await Buyer.findById(buyerId);
    const demandService = await import('../src/modules/demand/demand.service.js');
    const { askId } = await demandService.raiseAsk(
      (buyer!.counterpartyId as unknown as string).toString(),
      { skuId, allPacks: false, qty: 5, conditionRequirement: { expiryBand: 'over12' } },
    );

    let queue = await purchaseService.getOnBoardNotQuotedQueue();
    expect(queue.find((q) => q.askId === askId)).toMatchObject({ sellersListedNotQuoted: 1 });

    await demandService.postQuote(sellerCounterpartyId, askId, {
      ratePaiseForIndore: 41000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '2-5d',
      provenance: 'company',
      daysToIndore: 2,
    });

    queue = await purchaseService.getOnBoardNotQuotedQueue();
    expect(queue.find((q) => q.askId === askId)).toBeUndefined();
  });
});

describe('Purchase-desk v2 — return-note due date', () => {
  it("surfaces the already-stored ReturnNote.dueBy as the Recovery screen's due date", async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const { ReturnNote } = await import('../src/models/ReturnNote.js');
    const dueBy = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
    const note = await ReturnNote.create({
      poId: new Types.ObjectId(),
      sellerId,
      cases: 3,
      reason: 'Damaged in transit',
      dueBy,
    });

    const rows = await purchaseService.getReturnNoteAgeing();
    const row = rows.find((r) => r.returnNoteId === (note._id as Types.ObjectId).toString());
    expect(row).toBeDefined();
    expect(new Date(row!.dueDate).getTime()).toBe(dueBy.getTime());

    const file = await purchaseService.getSellerFile(sellerId);
    const fileRow = file.openReturnNotes.find(
      (r) => r.returnNoteId === (note._id as Types.ObjectId).toString(),
    );
    expect(fileRow).toBeDefined();
    expect(new Date(fileRow!.dueDate).getTime()).toBe(dueBy.getTime());
  });
});

describe('Purchase-desk v2 — per-seller performance metrics (BR-275)', () => {
  it("does not leak another seller's debits into this seller's performance panel", async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerA = await makeSeller(purchase.token);
    const sellerB = await makeSeller(purchase.token);
    const { SellerDebit } = await import('../src/models/SellerDebit.js');
    await SellerDebit.create({
      counterpartyId: sellerA,
      reason: 'Freight paid',
      amountPaise: 5000,
    });
    await SellerDebit.create({
      counterpartyId: sellerB,
      reason: 'Freight paid',
      amountPaise: 7000,
    });
    await SellerDebit.create({
      counterpartyId: sellerB,
      reason: 'Freight paid',
      amountPaise: 8000,
    });

    const fileA = await purchaseService.getSellerFile(sellerA);
    const fileB = await purchaseService.getSellerFile(sellerB);
    expect(fileA.performance.debitsRaisedCount).toBe(1);
    expect(fileB.performance.debitsRaisedCount).toBe(2);
    // Counted, never valued — the same BR-067/BR-069 wall the desk-wide
    // funnel keeps, re-verified at the per-seller granularity.
    expect(JSON.stringify(fileA.performance)).not.toContain('5000');
  });
});

describe('Purchase-desk v2 — B-03, exact-duplicate listing', () => {
  function listingInput(sellerCounterpartyId: string, productId: string, skuId: string) {
    return {
      sellerCounterpartyId,
      productId,
      scopeType: 'my_area' as const,
      lines: [
        {
          skuId,
          ratePaise: 28000,
          expiryBand: 'over12' as const,
          deliveryBand: '48h' as const,
          provenance: 'company' as const,
          qty: 10,
        },
      ],
      callNote: 'Called 30 Sep, gave the same rate again by mistake.',
    };
  }

  it('refuses an exact duplicate (same seller, SKU, rate and condition set) as a second live listing', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const seller = await Seller.findById(sellerId);
    const sellerCounterpartyId = seller!.counterpartyId.toString();
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    const first = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(listingInput(sellerCounterpartyId, productId, skuId));
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(listingInput(sellerCounterpartyId, productId, skuId));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_LISTING');
  });

  it('allows a second listing at a different rate on the same SKU (BR-087)', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const seller = await Seller.findById(sellerId);
    const sellerCounterpartyId = seller!.counterpartyId.toString();
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    const first = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(listingInput(sellerCounterpartyId, productId, skuId));
    expect(first.status).toBe(201);

    const secondInput = listingInput(sellerCounterpartyId, productId, skuId);
    secondInput.lines[0].ratePaise = 30000; // different rate — not a duplicate.
    const second = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(secondInput);
    expect(second.status).toBe(201);
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
    // QA fix — a seller name, not a raw ObjectId hash, on the dispatch screen.
    expect(row!.sellerFirm).toBeTruthy();
    expect(row!.sellerFirm).not.toBe('—');
  });
});

describe('Purchase-desk v2 — the seller file', () => {
  it('combines area, scorecard, catalogue and listings into one read, no buyer field anywhere', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
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
    const skuId = await createTestSku('Medium');
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

describe('Purchase-desk v2 — active demand list shows product, not a hash', () => {
  it('resolves brand/technical/manufacturerName for an ask, not just its raw ids', async () => {
    const sales = await staffToken(app, 'sales');
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();
    const { Product } = await import('../src/models/Product.js');
    const product = await Product.findById(productId);

    const tehsil = await createTehsil();
    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const { Buyer } = await import('../src/models/Buyer.js');
    const buyer = await Buyer.findById(buyerId);
    const demandService = await import('../src/modules/demand/demand.service.js');

    const { askId } = await demandService.raiseAsk(
      (buyer!.counterpartyId as unknown as string).toString(),
      { skuId, allPacks: false, qty: 5, conditionRequirement: { expiryBand: 'over12' } },
    );

    const items = await purchaseService.getActiveDemandList({});
    const row = items.find((i) => i.askId === askId);
    expect(row).toBeTruthy();
    expect(row!.brand).toBe(product!.brand);
    expect(row!.technical).toBe(product!.technical);
    expect(row!.manufacturerName).not.toBe('—');
  });
});

describe('Purchase-desk v2 — confirmations: the gap signal and the chase log', () => {
  it('computes the gap from what buyers piled against what the listing line said, and logs a chase against the pile', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const skuId = await createTestSku('Medium');
    const sku = await Sku.findById(skuId);
    const productId = sku!.productId.toString();

    const listing = await Listing.create({
      sellerId,
      productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const line = await ListingLine.create({
      listingId: listing._id,
      skuId,
      ratePaise: 40000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 10,
    });

    const opened = new Date();
    const pile = await Pile.create({
      listingLineId: line._id,
      openedAt: opened,
      confirmWindowEndsAt: new Date(opened.getTime() + 11 * 60 * 60 * 1000),
      decision: null,
    });
    await PileRequest.create({
      pileId: pile._id,
      buyerId: new Types.ObjectId(),
      qty: 15,
      deliveryLocationId: new Types.ObjectId(),
      requestedAt: opened,
    });

    const piles = await purchaseService.getPilesAwaitingDecision();
    const row = piles.find((p) => p.pileId === (pile._id as Types.ObjectId).toString());
    expect(row).toBeTruthy();
    expect(row!.boxes).toBe(15);
    expect(row!.lineQty).toBe(10);
    expect(row!.gapText).toBe('15 of 10 boxes in his listing');

    const res = await request(app)
      .post(`/api/v1/staff/purchase/piles/${row!.pileId}/chase`)
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ logged: true });

    const entry = await AuditLog.findOne({ entityId: pile._id, field: 'pile_chase_logged' });
    expect(entry).not.toBeNull();
  });
});
