import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { ProductMarginMatrix } from '../src/models/ProductMarginMatrix.js';
import { Sku } from '../src/models/Sku.js';
import { SoLine } from '../src/models/SoLine.js';
import { computeBuyerFacingRatePaise } from '../src/modules/listing/listing.service.js';
import { resolveBuyerMargin } from '../src/modules/pricing/pricing.service.js';
import {
  computeBuyerInclusiveRatePaiseWithRupeeMargin,
  computeBuyerRatePaiseWithMargin,
  marginPctOf,
} from '../src/shared/pricing.js';
import {
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
  staffToken,
} from './m4helpers.js';

const app = createApp();

const SELLER_NET_PAISE = 10_000; // ₹100 per base unit, taxable.

async function productIdOf(skuId: string): Promise<string> {
  const sku = await Sku.findById(skuId);
  return String(sku!.productId);
}

function putMargin(
  token: string,
  productId: string,
  cells: Array<{ tier: string; marginPaise: number | null }>,
  effectiveFrom: Date = new Date(Date.now() - 60_000),
) {
  return request(app)
    .put(`/api/v1/admin/products/${productId}/margin-matrix`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
    .send({ cells, effectiveFrom: effectiveFrom.toISOString() });
}

describe('Product margin — the rupee rate maths (₹100 taxable, ₹9 inclusive margin)', () => {
  it('adds the rupee margin after the GST gross-up, not before it', () => {
    // 10000 × 1.18 = 11800, + 900 = 12700 → ₹127.00. A margin before gross-up would be ₹127.62.
    expect(computeBuyerInclusiveRatePaiseWithRupeeMargin(SELLER_NET_PAISE, 900)).toBe(12700);
  });

  it('still prices a percentage margin the way it always did', () => {
    expect(computeBuyerRatePaiseWithMargin(SELLER_NET_PAISE, { kind: 'percent', pct: 0.08 })).toBe(
      12744,
    );
    expect(
      computeBuyerRatePaiseWithMargin(SELLER_NET_PAISE, { kind: 'rupees', marginPaise: 900 }),
    ).toBe(12700);
  });

  it('reads a rupee margin as a percentage of taxable cost, for the frozen line', () => {
    expect(marginPctOf(SELLER_NET_PAISE, { kind: 'rupees', marginPaise: 900 })).toBe(0.076271);
    expect(marginPctOf(SELLER_NET_PAISE, { kind: 'percent', pct: 0.05 })).toBe(0.05);
    expect(marginPctOf(0, { kind: 'rupees', marginPaise: 900 })).toBe(0);
  });

  it('refuses a negative or fractional rupee margin', () => {
    expect(() => computeBuyerInclusiveRatePaiseWithRupeeMargin(SELLER_NET_PAISE, -1)).toThrow();
    expect(() => computeBuyerInclusiveRatePaiseWithRupeeMargin(SELLER_NET_PAISE, 9.5)).toThrow();
  });
});

describe('Product margin — save, read, history (API)', () => {
  it('saves cells under one date, shows only the set tiers as current, and keeps history', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku());

    const save = await putMargin(admin.token, productId, [
      { tier: 'Retailer', marginPaise: 900 },
      { tier: 'Trader', marginPaise: 500 },
    ]);
    expect(save.status).toBe(201);
    expect(save.body.data).toHaveLength(2);

    // A later edit adds a row; it never rewrites the first.
    await putMargin(
      admin.token,
      productId,
      [{ tier: 'Retailer', marginPaise: 1100 }],
      new Date(Date.now() - 1000),
    ).expect(201);

    const current = await request(app)
      .get(`/api/v1/admin/products/${productId}/margin-matrix`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(current.status).toBe(200);
    const byTier = Object.fromEntries(
      (current.body.data as Array<{ tier: string; marginPaise: number }>).map((c) => [
        c.tier,
        c.marginPaise,
      ]),
    );
    expect(byTier).toEqual({ Retailer: 1100, Trader: 500 });

    const history = await request(app)
      .get(`/api/v1/admin/products/${productId}/margin-matrix/history`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(3);
    expect(await ProductMarginMatrix.countDocuments({ productId })).toBe(3);
  });

  it('rejects bad input and unknown products, and writes nothing', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku());

    await putMargin(admin.token, productId, [{ tier: 'Dealer', marginPaise: -100 }]).expect(400);
    await putMargin(admin.token, productId, [{ tier: 'Dealer', marginPaise: 12.5 }]).expect(400);
    await putMargin(admin.token, productId, [{ tier: 'Wholesaler', marginPaise: 100 }]).expect(400);
    await putMargin(admin.token, productId, [
      { tier: 'Dealer', marginPaise: 100 },
      { tier: 'Dealer', marginPaise: 200 },
    ]).expect(400);
    await putMargin(admin.token, '64b000000000000000000000', [
      { tier: 'Dealer', marginPaise: 100 },
    ]).expect(404);
    await putMargin(admin.token, 'not-an-id', [{ tier: 'Dealer', marginPaise: 100 }]).expect(400);

    expect(await ProductMarginMatrix.countDocuments({ productId })).toBe(0);
  });

  it('requires an Idempotency-Key, and a replay does not write a second time', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku());
    const body = {
      cells: [{ tier: 'Dealer', marginPaise: 700 }],
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    };
    const url = `/api/v1/admin/products/${productId}/margin-matrix`;

    await request(app)
      .put(url)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(body)
      .expect(400);

    const send = () =>
      request(app)
        .put(url)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', 'same-key-twice')
        .send(body);
    await send().expect(201);
    await send().expect(201);
    expect(await ProductMarginMatrix.countDocuments({ productId })).toBe(1);
  });

  it('is Admin-only to write and margin-permission-only to read', async () => {
    const sales = await staffToken(app, 'sales');
    const productId = await productIdOf(await createTestSku());

    await putMargin(sales.token, productId, [{ tier: 'Dealer', marginPaise: 100 }]).expect(403);
    await request(app)
      .get(`/api/v1/admin/products/${productId}/margin-matrix`)
      .set('Authorization', `Bearer ${sales.token}`)
      .expect(403);
  });
});

describe('Product margin — which margin applies (BR-040)', () => {
  it('uses the product rupee cell, and falls back to the class % for every other tier', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku('Medium'));
    await seedMarginCell('Medium', 'Retailer', 0.08, admin.employeeId);
    await seedMarginCell('Medium', 'Dealer', 0.06, admin.employeeId);
    await putMargin(admin.token, productId, [{ tier: 'Retailer', marginPaise: 900 }]).expect(201);

    expect(await resolveBuyerMargin(productId, 'Medium', 'Retailer')).toEqual({
      kind: 'rupees',
      marginPaise: 900,
    });
    expect(await resolveBuyerMargin(productId, 'Medium', 'Dealer')).toEqual({
      kind: 'percent',
      pct: 0.06,
    });
  });

  it('still refuses to price when neither the product nor the class has a cell', async () => {
    const productId = await productIdOf(await createTestSku('Low'));
    await expect(resolveBuyerMargin(productId, 'Low', 'Trader')).rejects.toMatchObject({
      code: 'MARGIN_CELL_MISSING',
    });
  });

  it('sends a tier back to the class % when its newest row is a null', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku('Medium'));
    await seedMarginCell('Medium', 'Retailer', 0.08, admin.employeeId);
    await putMargin(admin.token, productId, [{ tier: 'Retailer', marginPaise: 900 }]).expect(201);
    await putMargin(
      admin.token,
      productId,
      [{ tier: 'Retailer', marginPaise: null }],
      new Date(Date.now() - 1000),
    ).expect(201);

    expect(await resolveBuyerMargin(productId, 'Medium', 'Retailer')).toEqual({
      kind: 'percent',
      pct: 0.08,
    });
    const current = await request(app)
      .get(`/api/v1/admin/products/${productId}/margin-matrix`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(current.body.data).toEqual([]);
  });

  it('ignores a future-dated cell until its date, but lists it in history', async () => {
    const admin = await staffToken(app, 'admin');
    const productId = await productIdOf(await createTestSku('Medium'));
    await seedMarginCell('Medium', 'Dealer', 0.06, admin.employeeId);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await putMargin(
      admin.token,
      productId,
      [{ tier: 'Dealer', marginPaise: 500 }],
      tomorrow,
    ).expect(201);

    expect(await resolveBuyerMargin(productId, 'Medium', 'Dealer')).toEqual({
      kind: 'percent',
      pct: 0.06,
    });
    expect(
      await resolveBuyerMargin(productId, 'Medium', 'Dealer', new Date(tomorrow.getTime() + 1000)),
    ).toEqual({ kind: 'rupees', marginPaise: 500 });

    const history = await request(app)
      .get(`/api/v1/admin/products/${productId}/margin-matrix/history`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(history.body.data).toHaveLength(1);
  });
});

describe('Product margin — end to end: a placed order and the buyer feed', () => {
  it('prices an SO from the product rupee cell, freezes it, and leaves other products on the class %', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const buyerId = await createApprovedBuyer(app, sales.token); // a Dealer
    const sellerId = await createApprovedSeller(app, purchase.token);
    await seedMarginCell('Medium', 'Dealer', 0.05, admin.employeeId);

    const ownSku = await createTestSku('Medium'); // 20 base units per box
    const classOnlySku = await createTestSku('Medium');
    const ownProductId = await productIdOf(ownSku);
    await putMargin(admin.token, ownProductId, [{ tier: 'Dealer', marginPaise: 900 }]).expect(201);

    const placeSo = async (skuId: string) => {
      const res = await request(app)
        .post('/api/v1/staff/so')
        .set('Authorization', `Bearer ${sales.token}`)
        .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
        .send({
          buyerId,
          sellerId,
          skuId,
          boxes: 2,
          sellerNetPaise: SELLER_NET_PAISE,
          placeOfSupply: 'intra_state',
        });
      expect(res.status).toBe(201);
      return (await SoLine.findOne({ soId: res.body.data.soId }))!;
    };

    const own = await placeSo(ownSku);
    expect(own.ratePaise).toBe(12700); // ₹127.00 a unit
    expect(own.marginPaiseAtOrder).toBe(900);
    expect(own.marginPctAtOrder).toBe(0.076271);
    expect(own.totalPaise).toBe(2 * 20 * 12700);

    const classOnly = await placeSo(classOnlySku);
    expect(classOnly.ratePaise).toBe(12390); // 10000 × 1.05 × 1.18
    expect(classOnly.marginPaiseAtOrder).toBeNull();
    expect(classOnly.marginPctAtOrder).toBe(0.05);

    // BR-045 — a later change to the product's margin never moves a placed order.
    await putMargin(
      admin.token,
      ownProductId,
      [{ tier: 'Dealer', marginPaise: 1500 }],
      new Date(Date.now() - 1000),
    ).expect(201);
    expect((await SoLine.findById(own._id))!.ratePaise).toBe(12700);

    // The buyer-facing rate (feed, buy screen, enquiry) follows the same rule.
    const buyer = (await Buyer.findById(buyerId))!;
    expect(await computeBuyerFacingRatePaise(buyer, ownSku, SELLER_NET_PAISE as never)).toBe(
      11800 + 1500,
    );
    expect(await computeBuyerFacingRatePaise(buyer, classOnlySku, SELLER_NET_PAISE as never)).toBe(
      12390,
    );
  });
});
