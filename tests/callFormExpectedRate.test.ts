import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { Sku } from '../src/models/Sku.js';
import { Product } from '../src/models/Product.js';
import { raiseAskSchema } from '../src/modules/demand/demand.validation.js';
import { staffToken, createApprovedBuyer, createTestSku } from './m4helpers.js';

const app = createApp();

describe('Log a buyer call — expected rate', () => {
  it('stores what he hopes to pay on the ask, shows it on his file, and keeps the buyer endpoint price-free', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const counterpartyId = (await Buyer.findById(buyerId))!.counterpartyId!.toString();
    const skuId = await createTestSku('Medium');

    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks/batch')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: counterpartyId,
        callNote: 'Called about two products.',
        lines: [
          {
            skuId,
            qty: 4,
            conditionRequirement: { expiryBand: 'over12' },
            expectedRatePaise: 125000,
          },
          { skuId, qty: 2, conditionRequirement: { expiryBand: 'over12' } },
        ],
      });
    expect(res.status).toBe(201);
    const results = res.body.data.results as Array<{ askId: string }>;
    expect((await Ask.findById(results[0]!.askId))!.expectedRatePaise).toBe(125000);
    expect((await Ask.findById(results[1]!.askId))!.expectedRatePaise).toBeNull();

    const file = await request(app)
      .get(`/api/v1/staff/sales/buyers/${buyerId}`)
      .set('Authorization', `Bearer ${sales.token}`);
    const asks = file.body.data.openAsks as Array<{
      askId: string;
      expectedRatePaise: number | null;
    }>;
    expect(asks.find((a) => a.askId === results[0]!.askId)!.expectedRatePaise).toBe(125000);
    expect(asks.find((a) => a.askId === results[1]!.askId)!.expectedRatePaise).toBeNull();

    // BR-121 — the buyer's own ask schema still refuses any price.
    expect(
      raiseAskSchema.safeParse({
        skuId,
        qty: 1,
        conditionRequirement: { expiryBand: 'over12' },
        expectedRatePaise: 100,
      }).success,
    ).toBe(false);
  });

  it('stores the expected rate from the single-ask endpoint too', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const counterpartyId = (await Buyer.findById(buyerId))!.counterpartyId!.toString();
    const skuId = await createTestSku('Medium');
    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: counterpartyId,
        callNote: 'One product.',
        skuId,
        qty: 3,
        conditionRequirement: { expiryBand: 'over12' },
        expectedRatePaise: 98000,
      });
    expect(res.status).toBe(201);
    expect((await Ask.findById(res.body.data.askId))!.expectedRatePaise).toBe(98000);
  });

  it('refuses a zero or negative expected rate', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const counterpartyId = (await Buyer.findById(buyerId))!.counterpartyId!.toString();
    const skuId = await createTestSku('Medium');
    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks/batch')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: counterpartyId,
        callNote: 'Bad rate.',
        lines: [
          { skuId, qty: 1, conditionRequirement: { expiryBand: 'over12' }, expectedRatePaise: 0 },
        ],
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('GET /catalog/product-search', () => {
  it('finds a live product by part of its brand or its technical, for any signed-in staff', async () => {
    const sales = await staffToken(app, 'sales');
    const skuId = await createTestSku('Medium');
    const sku = (await Sku.findById(skuId))!;
    const product = (await Product.findById(sku.productId))!;

    const byBrand = await request(app)
      .get('/api/v1/catalog/product-search')
      .query({ q: product.brand.slice(0, product.brand.length - 1).toLowerCase() })
      .set('Authorization', `Bearer ${sales.token}`);
    expect(byBrand.status).toBe(200);
    const hit = (
      byBrand.body.data as Array<{ productId: string; brand: string; technical: string }>
    ).find((p) => p.productId === String(product._id));
    expect(hit).toMatchObject({ brand: product.brand, technical: product.technical });

    const none = await request(app)
      .get('/api/v1/catalog/product-search')
      .query({ q: 'zzz-no-such-product-zzz' })
      .set('Authorization', `Bearer ${sales.token}`);
    expect(none.body.data).toEqual([]);

    const anon = await request(app).get('/api/v1/catalog/product-search');
    expect(anon.status).toBe(401);
  });
});
