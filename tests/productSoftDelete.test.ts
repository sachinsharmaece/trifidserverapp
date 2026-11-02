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
import { Counterparty } from '../src/models/Counterparty.js';
import { Seller } from '../src/models/Seller.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { relistListing } from '../src/modules/listing/listing.service.js';
import { getBoardProducts, getBoardProduct } from '../src/modules/desk/sales/sales.board.js';
import { staffToken } from './m4helpers.js';
import { randomMobile } from './helpers.js';

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
    const sellerCp = await Counterparty.create({
      kind: 'seller',
      status: 'active',
      firm: `${tag} Seller`,
      mobile: randomMobile(),
    });
    const seller = await Seller.create({ counterpartyId: sellerCp._id });
    const listing = await Listing.create({
      sellerId: seller._id,
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
    // 30 Oct — it names whose listing it is, and no longer suggests unticking Active.
    expect(refused.body.error.meta.reasons).toEqual([
      `1 live listing (${tag} Seller)`,
      '1 open ask',
    ]);
    expect(refused.body.error.message_en).not.toMatch(/untick Active/);
    expect((await Product.findById(id))!.deletedAt).toBeNull();

    // 30 Oct — a paused listing no longer holds it (it is off every board, and cannot relist
    // once the product is gone); the closed ask lets it go.
    listing.state = 'paused';
    await listing.save();
    await Ask.updateMany({ skuId: sku._id }, { state: 'withdrawn' });
    expect((await as(admin.token).del(`/admin/products/${id}`)).status).toBe(200);
    await expect(relistListing(String(sellerCp._id), String(listing._id))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect((await Listing.findById(listing._id))!.state).toBe('paused');
  });

  it('an inactive product is off the Sales board until it is ticked Active again (30 Oct)', async () => {
    const tag = `Off${Date.now()}`;
    const { product, sku } = await makeProduct(tag);
    const sellerCp = await Counterparty.create({
      kind: 'seller',
      status: 'active',
      firm: `${tag} Seller`,
      mobile: randomMobile(),
    });
    const seller = await Seller.create({ counterpartyId: sellerCp._id });
    const listing = await Listing.create({
      sellerId: seller._id,
      productId: product._id,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId: sku._id,
      ratePaise: 39000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 100,
    });
    const onBoard = async () =>
      (await getBoardProducts()).some((r) => r.productId === String(product._id));
    expect(await onBoard()).toBe(true);

    await Product.updateOne({ _id: product._id }, { active: false });
    expect(await onBoard()).toBe(false);
    expect((await getBoardProduct(String(product._id), {})).ladder).toEqual([]);
    // The listing itself is untouched, so ticking Active brings it straight back.
    expect((await Listing.findById(listing._id))!.state).toBe('live');

    await Product.updateOne({ _id: product._id }, { active: true });
    expect(await onBoard()).toBe(true);
  });

  it('needs catalog:write', async () => {
    const { product } = await makeProduct(`Perm${Date.now()}`);
    const sales = await staffToken(app, 'sales');
    expect((await as(sales.token).del(`/admin/products/${String(product._id)}`)).status).toBe(403);
  });
});
