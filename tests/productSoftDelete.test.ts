import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Product } from '../src/models/Product.js';
import { Sku } from '../src/models/Sku.js';
import { Ask } from '../src/models/Ask.js';
import { Listing } from '../src/models/Listing.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { staffToken } from './m4helpers.js';

/**
 * 29 Oct — soft delete of a product from Manage → Products (BR-370): it leaves every list and
 * picker but the row stays; refused while anything live points at it; restore brings it back
 * inactive; both audited.
 */
const app = createApp();
let admin: { token: string; employeeId: string };
const as = (token: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  del: (path: string) =>
    request(app)
      .delete(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()),
  post: (path: string) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()),
});

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
}, 60000);

async function makeProduct(tag: string) {
  const manufacturer = await Manufacturer.create({ name: `${tag} Co` });
  const product = await Product.create({
    brand: `${tag} Brand`,
    technical: 'Glyphosate',
    manufacturerId: manufacturer._id,
    hsn: '38089110',
  });
  const sku = await Sku.create({
    productId: product._id,
    packLabel: '1 LTR',
    packSize: 1,
    baseUnit: 'LTR',
    unitsPerBox: 20,
  });
  return { product, sku };
}

describe('Manage → Products — soft delete (29 Oct)', () => {
  it('hides it from the lists and pickers, keeps the row, lists it as deleted, and restores it inactive', async () => {
    const tag = `Del${Date.now()}`;
    const { product } = await makeProduct(tag);
    const id = String(product._id);
    const api = as(admin.token);

    const del = await api.del(`/admin/products/${id}`);
    expect(del.status).toBe(200);

    expect((await api.get(`/admin/products?q=${tag}`)).body.meta.total).toBe(0);
    expect((await api.get(`/catalog/product-search?q=${tag}`)).body.data).toEqual([]);
    expect((await api.get(`/admin/products/${id}`)).status).toBe(404);
    // The row stays, so a past order can still read its name.
    const kept = await Product.findById(id);
    expect(kept).toMatchObject({ brand: `${tag} Brand`, active: false });
    expect(kept!.deletedAt).toBeInstanceOf(Date);

    const deleted = await api.get(`/admin/products?q=${tag}&deleted=true`);
    expect(deleted.body.data).toHaveLength(1);
    expect(deleted.body.data[0]).toMatchObject({ productId: id, deletedByName: 'Test admin' });
    expect(deleted.body.data[0].deletedAt).toBeTruthy();

    // Deleting it again is a 404; restoring brings it back, inactive.
    expect((await api.del(`/admin/products/${id}`)).status).toBe(404);
    expect((await api.post(`/admin/products/${id}/restore`)).status).toBe(200);
    const back = await api.get(`/admin/products?q=${tag}`);
    expect(back.body.data[0]).toMatchObject({ productId: id, active: false });
    expect((await api.get(`/admin/products?q=${tag}&deleted=true`)).body.data).toHaveLength(0);

    const audits = await AuditLog.find({ entity: 'product', entityId: product._id }).sort({
      createdAt: 1,
    });
    expect(audits.map((a) => a.field)).toEqual(['delete', 'restore']);
  });

  it('is refused while a live listing or an open ask still points at it', async () => {
    const tag = `Use${Date.now()}`;
    const { product, sku } = await makeProduct(tag);
    const id = String(product._id);
    const listing = await Listing.create({
      sellerId: new Types.ObjectId(),
      productId: product._id,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await Ask.create({
      buyerId: new Types.ObjectId(),
      skuId: sku._id,
      allPacks: false,
      qty: 4,
      conditionRequirement: { expiryBand: 'over12' },
      visibleToAllAt: new Date(),
      headStartOpenedAt: new Date(),
      ttlAt: new Date(Date.now() + 86_400_000),
      state: 'open',
    });

    const refused = await as(admin.token).del(`/admin/products/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PRODUCT_IN_USE');
    expect(refused.body.error.message_en).toMatch(/1 live listing, 1 open ask/);
    expect((await Product.findById(id))!.deletedAt).toBeNull();

    // Once the listing is withdrawn and the ask closed, it can go.
    listing.state = 'withdrawn';
    await listing.save();
    await Ask.updateMany({ skuId: sku._id }, { state: 'withdrawn' });
    expect((await as(admin.token).del(`/admin/products/${id}`)).status).toBe(200);
  });

  it('needs catalog:write', async () => {
    const { product } = await makeProduct(`Perm${Date.now()}`);
    const sales = await staffToken(app, 'sales');
    expect((await as(sales.token).del(`/admin/products/${String(product._id)}`)).status).toBe(403);
  });
});
