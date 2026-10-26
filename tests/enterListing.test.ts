import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Sku } from '../src/models/Sku.js';
import { Product } from '../src/models/Product.js';
import { Seller } from '../src/models/Seller.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { staffToken, createTestSku } from './m4helpers.js';
import { createTehsil, createApprovedSellerAtTehsils } from './m5helpers.js';

/**
 * 25 Oct — Purchase → seller → Enter a listing. A new product shows for a
 * seller only once he carries it; the desk can add it to his catalogue from
 * the listing screen, and nothing switched off in Manage can be listed.
 */
const app = createApp();
let purchase: { token: string; employeeId: string };
let sellerId: string;
let counterpartyId: string;
let n = 0;
const key = () => `listing-${Date.now()}-${(n += 1)}`;

const catalogue = async () =>
  (
    await request(app)
      .get(`/api/v1/staff/purchase/sellers/${sellerId}/catalogue`)
      .set('Authorization', `Bearer ${purchase.token}`)
  ).body.data as Array<{
    productId: string;
    productActive: boolean;
    manufacturerState: string;
    packs: Array<{ skuId: string; packLabel: string }>;
  }>;

const addToCatalogue = (productId: string, withKey = true) => {
  const r = request(app)
    .post('/api/v1/staff/purchase/catalogue')
    .set('Authorization', `Bearer ${purchase.token}`);
  return (withKey ? r.set('Idempotency-Key', key()) : r).send({ sellerId, productId });
};

const list = (productId: string, skuId: string) =>
  request(app)
    .post('/api/v1/staff/proxy/seller/listings')
    .set('Authorization', `Bearer ${purchase.token}`)
    .send({
      sellerCounterpartyId: counterpartyId,
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
      callNote: 'On a call, 25 Oct.',
    });

beforeAll(async () => {
  purchase = await staffToken(app, 'purchase');
  sellerId = await createApprovedSellerAtTehsils(app, purchase.token, [await createTehsil()]);
  counterpartyId = String((await Seller.findById(sellerId))!.counterpartyId);
}, 60000);

describe('Enter a listing — a product he does not carry yet', () => {
  it('is missing until added to his catalogue, then lists with its packs; the add is keyed and audited', async () => {
    const skuId = await createTestSku('Medium');
    const productId = String((await Sku.findById(skuId))!.productId);
    expect((await catalogue()).some((c) => c.productId === productId)).toBe(false);

    expect((await addToCatalogue(productId, false)).status).toBe(400);
    const added = await addToCatalogue(productId);
    expect(added.status).toBe(201);
    const row = (await catalogue()).find((c) => c.productId === productId)!;
    expect(row).toMatchObject({ productActive: true, manufacturerState: 'live' });
    expect(row.packs.map((p) => p.skuId)).toEqual([skuId]);
    expect(
      await AuditLog.countDocuments({
        entity: 'seller_catalogue_entry',
        entityId: added.body.data.entryId,
      }),
    ).toBe(1);

    expect((await list(productId, skuId)).status).toBe(201);
  });
});

describe('Enter a listing — nothing switched off in Manage', () => {
  it('an inactive pack is not offered, and is refused if sent', async () => {
    const skuId = await createTestSku('Medium');
    const productId = String((await Sku.findById(skuId))!.productId);
    await addToCatalogue(productId);
    await Sku.updateOne({ _id: skuId }, { $set: { active: false } });
    const row = (await catalogue()).find((c) => c.productId === productId)!;
    expect(row.packs).toEqual([]);
    const res = await list(productId, skuId);
    expect(res.status).toBe(400);
    expect(res.body.error.message_en).toMatch(/inactive/);
  });

  it('an inactive product cannot be added to a catalogue or listed', async () => {
    const skuId = await createTestSku('Medium');
    const productId = String((await Sku.findById(skuId))!.productId);
    await addToCatalogue(productId);
    await Product.updateOne({ _id: productId }, { $set: { active: false } });
    expect((await catalogue()).find((c) => c.productId === productId)?.productActive).toBe(false);
    const res = await list(productId, skuId);
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('productId');

    const other = String((await Sku.findById(await createTestSku('Medium')))!.productId);
    await Product.updateOne({ _id: other }, { $set: { active: false } });
    const refused = await addToCatalogue(other);
    expect(refused.status).toBe(400);
    expect(refused.body.error.field).toBe('productId');
  });
});
