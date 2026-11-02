import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Product } from '../src/models/Product.js';
import { Sku } from '../src/models/Sku.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { staffToken } from './m4helpers.js';

/**
 * 24 Oct — create and edit a product follow one flow: the same checks, the
 * same pack rule (a size in the unit typed, stored in the base unit), the
 * same Idempotency-Key, and both audited.
 */
const app = createApp();
let admin: { token: string; employeeId: string };
let manufacturerId: string;
let n = 0;
const key = () => `product-${Date.now()}-${(n += 1)}`;

const send = (method: 'post' | 'patch', path: string, body: object, withKey = key()) => {
  const r = request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${admin.token}`);
  return (withKey ? r.set('Idempotency-Key', withKey) : r).send(body);
};
const skusOf = async (productId: string) =>
  (
    await request(app)
      .get(`/api/v1/admin/products/${productId}/skus`)
      .set('Authorization', `Bearer ${admin.token}`)
  ).body.data as Array<{
    skuId: string;
    packLabel: string;
    packSize: number;
    unit: string;
    displaySize: number;
    active: boolean;
    state: string;
  }>;

async function product(brand: string, packs: object[] = []): Promise<string> {
  const res = await send('post', '/admin/products', {
    brand,
    technical: 'Glyphosate',
    manufacturerId,
    hsn: '38089110',
    category: 'pesticide',
    taxPercent: 18,
    class: 'Medium',
    packs,
  });
  expect(res.status).toBe(201);
  return res.body.data.productId as string;
}

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  const mfr = await send('post', '/admin/manufacturers', { name: `Mfr ${Date.now()}` });
  manufacturerId = mfr.body.data.manufacturerId as string;
}, 60000);

describe('Products — one pack rule on create and edit', () => {
  it('a pack reads back as typed (500 ML), stored as 0.5 LTR', async () => {
    const productId = await product('Rounder', [
      { packSize: 500, unit: 'ML', unitsPerBox: 20 },
      { packSize: 1, unit: 'LTR', unitsPerBox: 10 },
    ]);
    const skus = await skusOf(productId);
    const ml = skus.find((s) => s.packLabel === '500 ML')!;
    expect(ml).toMatchObject({ unit: 'ML', displaySize: 500, packSize: 0.5 });
    expect(skus.find((s) => s.packLabel === '1 LTR')).toMatchObject({
      unit: 'LTR',
      displaySize: 1,
    });
  });

  it('"Add pack" on edit stores a pack exactly as create does, and refuses one the product has', async () => {
    const productId = await product('Adder', [{ packSize: 500, unit: 'ML', unitsPerBox: 20 }]);
    const again = await send('post', `/admin/products/${productId}/packs`, {
      packs: [{ packSize: 0.5, unit: 'LTR', unitsPerBox: 20 }],
    });
    expect(again.status).toBe(400);
    expect(again.body.error.field).toBe('packs');
    expect(again.body.error.message_en).toMatch(/already has the pack "500 ML"/);

    const added = await send('post', `/admin/products/${productId}/packs`, {
      packs: [{ packSize: 250, unit: 'ML', unitsPerBox: 40 }],
    });
    expect(added.status).toBe(201);
    const sku = await Sku.findById(added.body.data.skuIds[0]);
    expect(sku).toMatchObject({ packLabel: '250 ML', packSize: 0.25, baseUnit: 'LTR' });
  });

  it('a pack’s size is edited in its own unit; its unit cannot change', async () => {
    const productId = await product('Editor', [
      { packSize: 500, unit: 'ML', unitsPerBox: 20 },
      { packSize: 1, unit: 'LTR', unitsPerBox: 10 },
    ]);
    const ml = (await skusOf(productId)).find((s) => s.unit === 'ML')!;
    const ok = await send('patch', `/admin/skus/${ml.skuId}`, {
      unit: 'ML',
      packSize: 750,
      unitsPerBox: 12,
    });
    expect(ok.status).toBe(200);
    expect(await Sku.findById(ml.skuId)).toMatchObject({
      packLabel: '750 ML',
      packSize: 0.75,
      unitsPerBox: 12,
    });

    const locked = await send('patch', `/admin/skus/${ml.skuId}`, { unit: 'LTR', packSize: 1 });
    expect(locked.status).toBe(400);
    expect(locked.body.error.field).toBe('unit');

    const clash = await send('patch', `/admin/skus/${ml.skuId}`, { unit: 'ML', packSize: 1000 });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message_en).toMatch(/already has the pack "1 LTR"/);
  });

  it('the Manage list keeps inactive and draft packs, so they can be switched back on or confirmed', async () => {
    const productId = await product('Keeper', [{ packSize: 1, unit: 'LTR', unitsPerBox: 10 }]);
    const [sku] = await skusOf(productId);
    await send('patch', `/admin/skus/${sku!.skuId}`, { active: false });
    await Sku.create({
      productId,
      packLabel: '5 LTR',
      packSize: 5,
      baseUnit: 'LTR',
      unitsPerBox: 4,
      state: 'draft',
    });
    const listed = await skusOf(productId);
    expect(listed.map((s) => [s.packLabel, s.active, s.state])).toEqual(
      expect.arrayContaining([
        ['1 LTR', false, 'live'],
        ['5 LTR', true, 'draft'],
      ]),
    );
  });
});

describe('Products — the same checks on create and edit', () => {
  it('edit refuses a manufacturer that does not exist, as create does', async () => {
    const productId = await product('Checker');
    const res = await send('patch', `/admin/products/${productId}`, {
      manufacturerId: '6a9e187e70030e7ede2070b0',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('manufacturerId');
  });

  it('every write needs an Idempotency-Key, and a repeated save makes one product', async () => {
    const body = {
      brand: 'Twice',
      technical: 'Glyphosate',
      manufacturerId,
      hsn: '38089110',
      taxPercent: 18,
    };
    expect((await send('post', '/admin/products', body, '')).status).toBe(400);
    const same = key();
    const first = await send('post', '/admin/products', body, same);
    const second = await send('post', '/admin/products', body, same);
    expect(second.body.data.productId).toBe(first.body.data.productId);
    expect(await Product.countDocuments({ brand: 'Twice' })).toBe(1);
    for (const path of ['/admin/technicals', '/admin/hsn']) {
      expect((await send('post', path, {}, '')).status).toBe(400);
    }
  });

  it('create, edit, add pack and pack edit are each audited', async () => {
    const productId = await product('Audited', [{ packSize: 1, unit: 'LTR', unitsPerBox: 10 }]);
    await send('patch', `/admin/products/${productId}`, { brand: 'Audited Two' });
    const added = await send('post', `/admin/products/${productId}/packs`, {
      packs: [{ packSize: 5, unit: 'LTR', unitsPerBox: 4 }],
    });
    const skuId = added.body.data.skuIds[0] as string;
    await send('patch', `/admin/skus/${skuId}`, { unitsPerBox: 2 });
    expect(await AuditLog.countDocuments({ entity: 'product', entityId: productId })).toBe(2);
    expect(await AuditLog.countDocuments({ entity: 'sku', entityId: skuId })).toBe(2);
  });
});
