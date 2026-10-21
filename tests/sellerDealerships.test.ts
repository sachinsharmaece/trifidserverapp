import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Product } from '../src/models/Product.js';
import { Seller } from '../src/models/Seller.js';
import { SellerDealership } from '../src/models/SellerDealership.js';
import { AuditLog } from '../src/models/AuditLog.js';
import * as purchaseService from '../src/modules/desk/purchase/purchase.service.js';
import * as onboardingService from '../src/modules/onboarding/onboarding.service.js';
import { staffToken } from './m4helpers.js';
import { createTehsil, createApprovedSellerAtTehsils } from './m5helpers.js';
import { randomGstin, randomMobile } from './helpers.js';

const app = createApp();

async function makeSeller(purchaseToken: string): Promise<string> {
  const tehsil = await createTehsil();
  return createApprovedSellerAtTehsils(app, purchaseToken, [tehsil]);
}

async function makeCompany(
  productCount: number,
): Promise<{ manufacturerId: string; productIds: string[] }> {
  const manufacturer = await Manufacturer.create({
    name: `Dealer Co ${Date.now()}-${Math.random()}`,
  });
  const productIds: string[] = [];
  for (let i = 0; i < productCount; i += 1) {
    const product = await Product.create({
      brand: `Brand ${i} ${Date.now()}-${Math.random()}`,
      technical: 'Glyphosate',
      manufacturerId: manufacturer._id,
      hsn: '38089110',
    });
    productIds.push(String(product._id));
  }
  return { manufacturerId: String(manufacturer._id), productIds };
}

function putDealerships(token: string, sellerId: string, manufacturerIds: string[]) {
  return request(app)
    .put(`/api/v1/staff/purchase/sellers/${sellerId}/dealerships`)
    .set('Authorization', `Bearer ${token}`)
    .send({ manufacturerIds });
}

describe('Seller dealerships — a ticked company means he carries all its products', () => {
  it('shows every product of a ticked company under what he sells, and counts them', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(2);

    const res = await putDealerships(purchase.token, sellerId, [company.manufacturerId]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject([
      { manufacturerId: company.manufacturerId, productCount: 2 },
    ]);

    const file = await purchaseService.getSellerFile(sellerId);
    expect(file.catalogue.map((c) => c.productId).sort()).toEqual([...company.productIds].sort());
    expect(file.catalogue.every((c) => c.source === 'dealership' && c.entryId === null)).toBe(true);
    expect(file.dealerships).toHaveLength(1);

    const matrix = await purchaseService.getSupplyMatrixBySeller();
    expect(matrix.find((r) => r.sellerId === sellerId)!.carryCount).toBe(2);
  });

  it('picks up a product added to the company later, with no further tick', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(1);
    await putDealerships(purchase.token, sellerId, [company.manufacturerId]);

    await Product.create({
      brand: `Late ${Date.now()}`,
      technical: 'Glyphosate',
      manufacturerId: company.manufacturerId,
      hsn: '38089110',
    });

    expect((await purchaseService.getSellerFile(sellerId)).catalogue).toHaveLength(2);
  });

  it('shows a product once when it is both hand-added and via the company — the manual row wins', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(2);
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId, productId: company.productIds[0]! },
      { employeeId: purchase.employeeId },
    );
    await putDealerships(purchase.token, sellerId, [company.manufacturerId]);

    const { catalogue } = await purchaseService.getSellerFile(sellerId);
    expect(catalogue).toHaveLength(2);
    expect(catalogue.find((c) => c.productId === company.productIds[0])!.source).toBe('manual');
    expect(catalogue.find((c) => c.productId === company.productIds[1])!.source).toBe('dealership');
  });

  it('unticking removes the company products but keeps what was added by hand', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(2);
    await purchaseService.upsertSellerCatalogueEntry(
      { sellerId, productId: company.productIds[0]! },
      { employeeId: purchase.employeeId },
    );
    await putDealerships(purchase.token, sellerId, [company.manufacturerId]);
    await putDealerships(purchase.token, sellerId, []);

    const file = await purchaseService.getSellerFile(sellerId);
    expect(file.dealerships).toHaveLength(0);
    expect(file.catalogue.map((c) => c.productId)).toEqual([company.productIds[0]]);
  });

  it('feeds the product-side reads too, so a seller is found by a product of his company', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(1);
    await putDealerships(purchase.token, sellerId, [company.manufacturerId]);

    const sellers = await purchaseService.getProductSellers(company.productIds[0]!);
    expect(sellers.map((s) => s.sellerId)).toContain(sellerId);
    const rows = await purchaseService.getSupplyMatrixByProduct();
    expect(rows.find((r) => r.productId === company.productIds[0])!.carryCount).toBe(1);
  });

  it('does not count an inactive product', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const company = await makeCompany(2);
    await Product.updateOne({ _id: company.productIds[0] }, { active: false });
    await putDealerships(purchase.token, sellerId, [company.manufacturerId]);

    expect((await purchaseService.getSellerFile(sellerId)).catalogue).toHaveLength(1);
  });

  it('writes only the difference, audit-logs it, and is a no-op when nothing changed', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const a = await makeCompany(1);
    const b = await makeCompany(1);

    await putDealerships(purchase.token, sellerId, [a.manufacturerId]);
    await putDealerships(purchase.token, sellerId, [a.manufacturerId, b.manufacturerId]);
    await putDealerships(purchase.token, sellerId, [a.manufacturerId, b.manufacturerId]);

    expect(await SellerDealership.countDocuments({ sellerId })).toBe(2);
    expect(await AuditLog.countDocuments({ entityId: sellerId, field: 'dealerships' })).toBe(2);
  });

  it('rejects a company that does not exist', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await makeSeller(purchase.token);
    const res = await putDealerships(purchase.token, sellerId, ['64b000000000000000000000']);
    expect(res.status).toBe(400);
    expect(await SellerDealership.countDocuments({ sellerId })).toBe(0);
  });

  it('lets the desk tick companies when registering a seller', async () => {
    const company = await makeCompany(3);
    const { registrationId } = await onboardingService.registerSeller(
      {
        mobile: randomMobile(),
        firm: `Dealer Firm ${Date.now()}`,
        gstin: await randomGstin(),
        ownerName: 'Owner Name',
        licenceNo: 'MP/IND/INS/2016/0771',
        references: [
          {
            firm: 'Ref One',
            phone: '9000000001',
            relationship: 'Supplier',
            whatTheySaid: 'Reliable',
          },
          {
            firm: 'Ref Two',
            phone: '9000000002',
            relationship: 'Supplier',
            whatTheySaid: 'Reliable',
          },
        ],
        dealerships: [{ manufacturerId: company.manufacturerId }],
        bankDetail: {
          accountNumber: '000900012345678',
          ifsc: 'HDFC0001234',
          accountName: 'Owner Name',
        },
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      },
      { employeeId: '64b000000000000000000001', callNote: 'Called.', correlationId: 'test' },
    );
    const seller = await Seller.findOne({ counterpartyId: registrationId });
    const file = await purchaseService.getSellerFile(String(seller!._id));
    expect(file.catalogue).toHaveLength(3);
  });
});
