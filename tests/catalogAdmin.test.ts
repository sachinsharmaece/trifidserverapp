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
    const startCursor = latestExisting ? (latestExisting._id as { toString(): string }).toString() : '';

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
