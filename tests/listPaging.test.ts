import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Product } from '../src/models/Product.js';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { CallLog } from '../src/models/CallLog.js';
import type { Types } from 'mongoose';
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
  it('searches product, technical or company; pages with a total in the chosen order', async () => {
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
    const ids = (body: { data: Array<{ productId: string }> }) => body.data.map((p) => p.productId);
    // 30 Oct — product name A→Z by default, and page two carries on from page one.
    const first = await get(`/admin/products?q=${tag}&limit=2`);
    expect(first.body.meta.total).toBe(3);
    expect(ids(first.body)).toEqual([made[0], made[1]]);
    const second = await get(
      `/admin/products?q=${tag}&limit=2&cursor=${first.body.meta.nextCursor}`,
    );
    expect(ids(second.body)).toEqual([made[2]]);
    expect(second.body.meta.nextCursor).toBeUndefined();
    // Z→A, and newest added first.
    expect(ids((await get(`/admin/products?q=${tag}&dir=desc`)).body)).toEqual([
      made[2],
      made[1],
      made[0],
    ]);
    expect(ids((await get(`/admin/products?q=${tag}&sort=created&dir=desc`)).body)).toEqual([
      made[2],
      made[1],
      made[0],
    ]);
    // By company name too.
    expect(
      (await get(`/admin/products?q=${encodeURIComponent(`${tag} Agro`)}`)).body.meta.total,
    ).toBe(3);
  });

  it('sorts by company and technical, ignoring case (30 Oct)', async () => {
    const tag = `Ps${Date.now()}`;
    const zeta = await Manufacturer.create({ name: `${tag} zeta Co` });
    const alpha = await Manufacturer.create({ name: `${tag} Alpha Co` });
    const make = async (brand: string, technical: string, manufacturerId: unknown) =>
      String(
        (
          await Product.create({
            brand: `${tag} ${brand}`,
            technical,
            manufacturerId,
            hsn: '38089110',
          })
        )._id,
      );
    const a = await make('apple', 'Zineb', zeta._id);
    const b = await make('Banana', 'atrazine', alpha._id);
    const ids = (body: { data: Array<{ productId: string }> }) => body.data.map((p) => p.productId);
    expect(ids((await get(`/admin/products?q=${tag}`)).body)).toEqual([a, b]);
    expect(ids((await get(`/admin/products?q=${tag}&sort=manufacturer`)).body)).toEqual([b, a]);
    expect(ids((await get(`/admin/products?q=${tag}&sort=technical`)).body)).toEqual([b, a]);
    expect(ids((await get(`/admin/products?q=${tag}&sort=technical&dir=desc`)).body)).toEqual([
      a,
      b,
    ]);
    expect((await get(`/admin/products?q=${tag}&sort=nope`)).status).toBe(400);
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

  it('shows when each buyer was last called and by whom, and sorts on it (30 Oct)', async () => {
    const tag = `Call${Date.now()}`;
    const day = 86_400_000;
    const make = async (firm: string) => {
      const cp = await Counterparty.create({
        kind: 'buyer',
        status: 'active',
        firm: `${tag} ${firm}`,
        mobile: randomMobile(),
      });
      return Buyer.create({ counterpartyId: cp._id });
    };
    const tenDays = await make('Alpha');
    const yesterday = await make('Bravo');
    const never = await make('Charlie');
    const log = (buyerId: unknown, kind: string, at: Date) =>
      CallLog.create({
        buyerId,
        employeeId: admin.employeeId,
        kind,
        note: 'test',
        at,
        ...(kind === 'call' ? { outcome: 'asked_for_a_rate' } : {}),
      });
    await log(tenDays._id, 'call', new Date(Date.now() - 10 * day));
    await log(yesterday._id, 'update_request', new Date(Date.now() - day));
    // A note is not a conversation: it neither counts nor moves the date.
    await log(tenDays._id, 'note', new Date());
    await log(never._id, 'note', new Date());

    type Row = { firm: string; lastCalledAt: string | null; lastCalledBy: string | null };
    const rows = (await get(`/staff/sales/buyers?q=${tag}&limit=10`)).body.data as Row[];
    const byFirm = new Map(rows.map((r) => [r.firm, r]));
    const ago = (r: Row) => Math.round((Date.now() - Date.parse(r.lastCalledAt!)) / day);
    expect(ago(byFirm.get(`${tag} Alpha`)!)).toBe(10);
    expect(byFirm.get(`${tag} Alpha`)!.lastCalledBy).toBe('Test admin');
    expect(ago(byFirm.get(`${tag} Bravo`)!)).toBe(1);
    expect(byFirm.get(`${tag} Charlie`)).toMatchObject({ lastCalledAt: null, lastCalledBy: null });

    const firms = (body: { data: Row[] }) => body.data.map((r) => r.firm.replace(`${tag} `, ''));
    // Longest ago first: never called leads.
    expect(
      firms((await get(`/staff/sales/buyers?q=${tag}&limit=10&sort=lastCalled`)).body),
    ).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(
      firms((await get(`/staff/sales/buyers?q=${tag}&limit=10&sort=lastCalled&dir=desc`)).body),
    ).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('sorts firm A→Z by default, across pages; Z→A, rate views and tehsil on request', async () => {
    const tag = `Srt${Date.now()}`;
    const t1 = await Tehsil.create({ name: `${tag} Zeta`, district: `${tag} D1`, state: 'MP' });
    const t2 = await Tehsil.create({ name: `${tag} Alpha`, district: `${tag} D2`, state: 'MP' });
    const rows: Array<[string, number, Types.ObjectId | null]> = [
      [`${tag} charlie`, 5, t2._id as Types.ObjectId],
      [`${tag} Alpha`, 0, null],
      [`${tag} bravo`, 9, t1._id as Types.ObjectId],
    ];
    for (const [firm, rateViews, tehsilId] of rows) {
      const cp = await Counterparty.create({
        kind: 'buyer',
        status: 'active',
        firm,
        mobile: randomMobile(),
      });
      await Buyer.create({ counterpartyId: cp._id, rateViews, tehsilId });
    }
    const firms = (body: { data: Array<{ firm: string }> }) => body.data.map((r) => r.firm);
    const [a, b, c] = [`${tag} Alpha`, `${tag} bravo`, `${tag} charlie`];

    // Default: firm A→Z, ignoring case, and page two carries on from page one.
    const first = await get(`/staff/sales/buyers?q=${tag}&limit=2`);
    expect(firms(first.body)).toEqual([a, b]);
    const second = await get(`/staff/sales/buyers?q=${tag}&limit=2&cursor=2`);
    expect(firms(second.body)).toEqual([c]);

    expect(firms((await get(`/staff/sales/buyers?q=${tag}&limit=5&dir=desc`)).body)).toEqual([
      c,
      b,
      a,
    ]);
    expect(
      firms((await get(`/staff/sales/buyers?q=${tag}&limit=5&sort=rateViews&dir=desc`)).body),
    ).toEqual([b, c, a]);
    // Tehsil A→Z; the buyer with no tehsil goes last, in either direction.
    expect(firms((await get(`/staff/sales/buyers?q=${tag}&limit=5&sort=tehsil`)).body)).toEqual([
      c,
      b,
      a,
    ]);
    expect(
      firms((await get(`/staff/sales/buyers?q=${tag}&limit=5&sort=tehsil&dir=desc`)).body),
    ).toEqual([b, c, a]);
    // An unknown sort falls back to firm A→Z.
    expect(firms((await get(`/staff/sales/buyers?q=${tag}&limit=5&sort=nope`)).body)).toEqual([
      a,
      b,
      c,
    ]);
  });
});
