import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Product } from '../src/models/Product.js';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { staffToken } from './m4helpers.js';
import { randomMobile } from './helpers.js';

/**
 * 29 Oct — the long lists page from the server: Manage → Products (search,
 * newest first), the registrations "Waiting" lists (only buyers or only
 * sellers, with a total), and Sales → Buyers (pages, with every filter option).
 */
const app = createApp();
let admin: { token: string; employeeId: string };
const get = (path: string) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${admin.token}`);

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
}, 60000);

describe('Manage → Products — search and pages', () => {
  it('searches product, technical or company; newest first; pages with a total', async () => {
    const tag = `Pg${Date.now()}`;
    const company = await Manufacturer.create({ name: `${tag} Agro Co` });
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await Product.create({
        brand: `${tag} Brand ${i}`,
        technical: 'Glyphosate',
        manufacturerId: company._id,
        hsn: '38089110',
      });
      made.push(String(p._id));
    }
    const first = await get(`/admin/products?q=${tag}&limit=2`);
    expect(first.body.meta.total).toBe(3);
    expect(first.body.data.map((p: { productId: string }) => p.productId)).toEqual([
      made[2],
      made[1],
    ]);
    const second = await get(
      `/admin/products?q=${tag}&limit=2&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.body.data.map((p: { productId: string }) => p.productId)).toEqual([made[0]]);
    expect(second.body.meta.nextCursor).toBeUndefined();
    // By company name too.
    expect(
      (await get(`/admin/products?q=${encodeURIComponent(`${tag} Agro`)}`)).body.meta.total,
    ).toBe(3);
  });
});

describe('Registrations — only buyers or only sellers, with a total', () => {
  it('kind narrows the list and the total', async () => {
    const tag = `Kind${Date.now()}`;
    const b = await Counterparty.create({
      kind: 'buyer',
      status: 'pending',
      firm: `${tag} B`,
      mobile: randomMobile(),
    });
    await Buyer.create({ counterpartyId: b._id });
    const s = await Counterparty.create({
      kind: 'seller',
      status: 'pending',
      firm: `${tag} S`,
      mobile: randomMobile(),
    });
    await Seller.create({ counterpartyId: s._id });
    const sellers = await get(`/staff/registrations?stage=pending&kind=seller&q=${tag}`);
    expect(sellers.body.data.map((r: { firm: string }) => r.firm)).toEqual([`${tag} S`]);
    expect(sellers.body.meta.total).toBe(1);
    const all = await get(`/staff/registrations?stage=pending&q=${tag}`);
    expect(all.body.meta.total).toBe(2);
  });
});

describe('Sales → Buyers — pages with every filter option', () => {
  it('a page, the total, the next cursor, and the districts and people over the whole tab', async () => {
    const tag = `Buy${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      const cp = await Counterparty.create({
        kind: 'buyer',
        status: 'active',
        firm: `${tag} ${i}`,
        mobile: randomMobile(),
      });
      const buyer = await Buyer.create({ counterpartyId: cp._id });
      await BookAssignment.create({
        buyerId: buyer._id,
        ownerEmployeeId: admin.employeeId,
        assignedAt: new Date(),
        assignedBy: admin.employeeId,
      });
    }
    const first = await get(`/staff/sales/buyers?tab=book&q=${tag}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta).toMatchObject({ total: 3, nextCursor: '2' });
    expect(
      first.body.meta.facets.assignees.map((a: { employeeId: string }) => a.employeeId),
    ).toContain(admin.employeeId);
    const second = await get(`/staff/sales/buyers?tab=book&q=${tag}&limit=2&cursor=2`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeUndefined();
    // Without a limit, the whole list as before (the top-bar search).
    expect((await get(`/staff/sales/buyers?q=${tag}`)).body.data).toHaveLength(3);
  });
});
