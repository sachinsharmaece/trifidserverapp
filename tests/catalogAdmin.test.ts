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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: manufacturerName });
    expect(mfrRes.status).toBe(201);
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };

    const createRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({
        brand: 'Test Brand',
        technical: 'Test Technical',
        manufacturerId,
        hsn: '38089199',
        class: 'Medium',
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
      class: 'Medium',
      active: true,
    });
  });

  it('edits a product through the existing PATCH endpoint', async () => {
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const createRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ brand: 'Before', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = createRes.body.data as { productId: string };

    const editRes = await request(app)
      .patch(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '38089199' });
    const { productId } = productRes.body.data as { productId: string };
    const importRes = await request(app)
      .post('/api/v1/admin/skus/import')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ baseUnit: 'KG' });
    expect(editRes.status).toBe(400);
  });

  it('404s a SKU id that does not exist', async () => {
    const admin = await staffToken(app, 'admin');
    const res = await request(app)
      .patch('/api/v1/admin/skus/000000000000000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ packLabel: 'X' });
    expect(res.status).toBe(404);
  });
});

/** HSN must be 6 or 8 digits — any chapter, independent of the product category. */
describe('Admin catalog management — HSN validation', () => {
  it('rejects an HSN that is not 6 or 8 digits', async () => {
    const admin = await staffToken(app, 'admin');
    const mfrRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };

    const badRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: 'ABC' });
    expect(badRes.status).toBe(400);

    const wrongPrefixRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ brand: 'B', technical: 'T', manufacturerId, hsn: '1234' });
    expect(wrongPrefixRes.status).toBe(400);

    const goodRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name });
    expect(firstRes.status).toBe(201);

    const dupeRes = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    const { manufacturerId } = mfrRes.body.data as { manufacturerId: string };
    const productRes = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
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
      .set('Idempotency-Key', `cat-${Math.random()}`)
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

describe('Admin catalog management — masters, category, tax and packs', () => {
  async function newManufacturer(token: string): Promise<string> {
    const res = await request(app)
      .post('/api/v1/admin/manufacturers')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: `Mfr-${Date.now()}-${Math.random()}` });
    return (res.body.data as { manufacturerId: string }).manufacturerId;
  }

  it('creates a technical and an HSN master, rejects duplicates, and lists them', async () => {
    const admin = await staffToken(app, 'admin');
    const name = `Tech-${Date.now()}-${Math.random()}`;
    const code = String(Math.floor(10000000 + Math.random() * 89999999));

    const t = await request(app)
      .post('/api/v1/admin/technicals')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name });
    expect(t.status).toBe(201);
    const dupe = await request(app)
      .post('/api/v1/admin/technicals')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ name: name.toUpperCase() });
    expect(dupe.status).toBe(400);

    const h = await request(app)
      .post('/api/v1/admin/hsn')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ code, taxPercent: 5 });
    expect(h.status).toBe(201);
    const badHsn = await request(app)
      .post('/api/v1/admin/hsn')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ code: '12', taxPercent: 5 });
    expect(badHsn.status).toBe(400);
    const badTax = await request(app)
      .post('/api/v1/admin/hsn')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ code: '31051000', taxPercent: 150 });
    expect(badTax.status).toBe(400);

    const techs = await request(app)
      .get('/api/v1/admin/technicals')
      .set('Authorization', `Bearer ${admin.token}`);
    expect((techs.body.data as Array<{ name: string }>).some((x) => x.name === name)).toBe(true);
    const hsns = await request(app)
      .get('/api/v1/admin/hsn')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(
      (hsns.body.data as Array<{ code: string; taxPercent: number }>).find((x) => x.code === code)
        ?.taxPercent,
    ).toBe(5);
  });

  it('creates a fertilizer with a non-3808 HSN, its tax %, and packs in chosen units', async () => {
    const admin = await staffToken(app, 'admin');
    const manufacturerId = await newManufacturer(admin.token);
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({
        brand: 'Urea Plus',
        technical: `Urea-${Date.now()}`,
        manufacturerId,
        hsn: '31021000',
        category: 'fertilizer',
        taxPercent: 5,
        packs: [
          { packSize: 1, unit: 'LTR', unitsPerBox: 12 },
          { packSize: 500, unit: 'ML', unitsPerBox: 24 },
        ],
      });
    expect(res.status).toBe(201);
    const { productId, skuIds } = res.body.data as { productId: string; skuIds: string[] };
    expect(skuIds).toHaveLength(2);

    const detail = await request(app)
      .get(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.body.data).toMatchObject({ category: 'fertilizer', taxPercent: 5 });

    const skus = await request(app)
      .get(`/api/v1/catalog/products/${productId}/skus`)
      .set('Authorization', `Bearer ${admin.token}`);
    const ml = (
      skus.body.data as Array<{
        packLabel: string;
        packSize: number;
        baseUnit: string;
        baseUnitsPerBox: number;
      }>
    ).find((s) => s.packLabel === '500 ML');
    expect(ml).toMatchObject({ packSize: 0.5, baseUnit: 'LTR', baseUnitsPerBox: 12 });
  });

  it('defaults a product to pesticide, takes the HSN master rate, and adds its technical to the master', async () => {
    const admin = await staffToken(app, 'admin');
    const manufacturerId = await newManufacturer(admin.token);
    const technical = `Tech-${Date.now()}-${Math.random()}`;
    const code = String(Math.floor(10000000 + Math.random() * 89999999));
    await request(app)
      .post('/api/v1/admin/hsn')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ code, taxPercent: 12 });

    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({ brand: 'B', technical, manufacturerId, hsn: code });
    expect(res.status).toBe(201);
    const { productId } = res.body.data as { productId: string };
    const detail = await request(app)
      .get(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.body.data).toMatchObject({ category: 'pesticide', taxPercent: 12 });

    const techs = await request(app)
      .get('/api/v1/admin/technicals')
      .set('Authorization', `Bearer ${admin.token}`);
    expect((techs.body.data as Array<{ name: string }>).some((x) => x.name === technical)).toBe(
      true,
    );
  });

  it('rejects duplicate packs and rolls nothing half-created', async () => {
    const admin = await staffToken(app, 'admin');
    const manufacturerId = await newManufacturer(admin.token);
    const brand = `Dupe-${Date.now()}-${Math.random()}`;
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `cat-${Math.random()}`)
      .send({
        brand,
        technical: 'T',
        manufacturerId,
        hsn: '38089199',
        packs: [
          { packSize: 1, unit: 'KG', unitsPerBox: 10 },
          { packSize: 1, unit: 'KG', unitsPerBox: 20 },
        ],
      });
    expect(res.status).toBe(400);
    expect(await Product.countDocuments({ brand })).toBe(0);
  });
});
