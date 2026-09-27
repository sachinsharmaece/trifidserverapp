import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Product } from '../src/models/Product.js';
import { staffToken } from './m4helpers.js';

const app = createApp();

/** The Manage desk's own product list/detail reads — distinct from API-022's technical-scoped picker (BR-111). */
describe('Admin catalog management — products', () => {
  it('creates a product, lists it in the unfiltered admin list with its manufacturer name, and reads it by id', async () => {
    const admin = await staffToken(app, 'admin');

    // The list is cursor-paginated ascending on _id and other suites in a
    // full run seed far more than one page of products, so this test's own
    // product (the newest, highest _id) would not be on page one — start
    // the list at the moment this test began, the same fix M9's wall sweep
    // needed for the same class of bug (DEVELOPMENT_STATUS.md).
    const latestExisting = await Product.findOne().sort({ _id: -1 });
    const startCursor = latestExisting
      ? (latestExisting._id as { toString(): string }).toString()
      : '';

    const manufacturerName = `Mfr-${Date.now()}-${Math.random()}`;
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: manufacturerName });
    expect(mfrRes.status).toBe(201);
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };

    const createRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        brand: 'Test Brand',
        technical: 'Test Technical',
        manufacturerId,
        hsn: '38089199',
        class: 'B',
      });
    expect(createRes.status).toBe(201);
    const { productId } = createRes.body.data as { productId: string };

    const listRes = await request(app)
      .get(`/api/v1/admin/products?cursor=${encodeURIComponent(startCursor)}&limit=100`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body.data as Array<{ productId: string; manufacturerName?: string }>).find(
      (item) => item.productId === productId,
    );
    expect(row).toBeTruthy();
    expect(row?.manufacturerName).toBe(manufacturerName);

    const detailRes = await request(app)
      .get(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data).toMatchObject({
      productId,
      brand: 'Test Brand',
      technical: 'Test Technical',
      hsn: '38089199',
      class: 'B',
      active: true,
    });
  });

  it('edits a product through the existing PATCH endpoint', async () => {
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const createRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'Before', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = createRes.body.data as { productId: string };

    const editRes = await request(app)
      .patch(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'After', active: false });
    expect(editRes.status).toBe(200);

    const detailRes = await request(app)
      .get(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detailRes.body.data.brand).toBe('After');
    expect(detailRes.body.data.active).toBe(false);
  });

  it('refuses a caller without catalog:write', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(res.status).toBe(403);
  });

  it('404s a product id that does not exist', async () => {
    const admin = await staffToken(app, 'admin');
    const res = await request(app)
      .get('/api/v1/admin/products/000000000000000000000000')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });
});

/** New — the Manage desk's own SKU edit (BR-055). */
describe('Admin catalog management — SKU edit', () => {
  async function makeProductWithSku(admin: { token: string }) {
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = productRes.body.data as { productId: string };
    const importRes = await request(app)
      .post('/api/v1/admin/skus/import')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        productId,
        rows: [{ packLabel: '1L', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 }],
      });
    const [row] = importRes.body.data as Array<{ accepted: boolean; skuId: string }>;
    return { productId, skuId: row!.skuId };
  }

  it('edits packLabel/packSize/unitsPerBox and recomputes baseUnitsPerBox', async () => {
    const admin = await staffToken(app, 'admin');
    const { skuId } = await makeProductWithSku(admin);

    const editRes = await request(app)
      .patch(`/api/v1/admin/skus/${skuId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ packLabel: '2L', packSize: 2, unitsPerBox: 6 });
    expect(editRes.status).toBe(200);
    expect(editRes.body.data.baseUnitsPerBox).toBe(12); // 2 * 6, recomputed, not just copied.

    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);
    expect(sku!.packLabel).toBe('2L');
    expect(sku!.baseUnitsPerBox).toBe(12);
  });

  it('refuses to change baseUnit — the field is not even accepted', async () => {
    const admin = await staffToken(app, 'admin');
    const { skuId } = await makeProductWithSku(admin);

    const editRes = await request(app)
      .patch(`/api/v1/admin/skus/${skuId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ baseUnit: 'KG' });
    expect(editRes.status).toBe(400);
  });

  it('404s a SKU id that does not exist', async () => {
    const admin = await staffToken(app, 'admin');
    const res = await request(app)
      .patch('/api/v1/admin/skus/000000000000000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ packLabel: 'X' });
    expect(res.status).toBe(404);
  });
});

/** QA fix — HSN must be 6/8 digits starting with 3808 (this desk is pesticides-only). */
describe('Admin catalog management — HSN validation', () => {
  it('rejects an HSN that is not numeric or does not start with 3808', async () => {
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };

    const badRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: 'ABC' });
    expect(badRes.status).toBe(400);

    const wrongPrefixRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '1234' });
    expect(wrongPrefixRes.status).toBe(400);

    const goodRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '38089199' });
    expect(goodRes.status).toBe(201);
  });
});

/** QA fix — a case-only difference must not create a second manufacturer row. */
describe('Admin catalog management — duplicate manufacturer names', () => {
  it('blocks a case-insensitive duplicate company name', async () => {
    const admin = await staffToken(app, 'admin');
    const name = `Syngenta-${Date.now()}-${Math.random()}`;

    const firstRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name });
    expect(firstRes.status).toBe(201);

    const dupeRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: name.toLowerCase() });
    expect(dupeRes.status).toBe(400);
    expect(dupeRes.body.error.field).toBe('name');
  });
});

/** QA fix — a duplicate pack must fail cleanly, not with a raw 500. */
describe('Admin catalog management — duplicate pack', () => {
  it('rejects creating the same pack twice on the purchase-desk draft path', async () => {
    const purchase = await staffToken(app, 'purchase');
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = productRes.body.data as { productId: string };

    const firstPack = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ productId, packLabel: '1 LTR', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 });
    expect(firstPack.status).toBe(201);

    const dupePack = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ productId, packLabel: '1 LTR', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 });
    expect(dupePack.status).toBe(400);
    expect(dupePack.body.error.field).toBe('packLabel');
  });

  it('rejects a pack label that does not match its base unit', async () => {
    const purchase = await staffToken(app, 'purchase');
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = productRes.body.data as { productId: string };

    const mismatchRes = await request(app)
      .post('/api/v1/staff/purchase/masters/skus')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ productId, packLabel: '500 GM', packSize: 500, baseUnit: 'LTR', unitsPerBox: 12 });
    expect(mismatchRes.status).toBe(400);
  });
});

/** New — `aka` stops a seller's shorthand for a company becoming a second row. */
describe('Admin catalog management — manufacturer aka', () => {
  it('persists aka on create and on a later PATCH', async () => {
    const admin = await staffToken(app, 'admin');
    const name = `Bayer-${Date.now()}-${Math.random()}`;

    const createRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name, aka: ['Bayer CropScience'] });
    expect(createRes.status).toBe(201);
    const { manufacturerId } = createRes.body.data as { manufacturerId: string };

    const listRes = await request(app)
      .get('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`);
    const row = (listRes.body.data as Array<{ manufacturerId: string; aka?: string[] }>).find(
      (m) => m.manufacturerId === manufacturerId,
    );
    expect(row?.aka).toEqual(['Bayer CropScience']);

    const patchRes = await request(app)
      .patch(`/api/v1/admin/manufacturers/${manufacturerId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ aka: ['Bayer CropScience', 'Bayer India'] });
    expect(patchRes.status).toBe(200);

    const listAfter = await request(app)
      .get('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`);
    const rowAfter = (
      listAfter.body.data as Array<{ manufacturerId: string; aka?: string[] }>
    ).find((m) => m.manufacturerId === manufacturerId);
    expect(rowAfter?.aka).toEqual(['Bayer CropScience', 'Bayer India']);
  });
});
