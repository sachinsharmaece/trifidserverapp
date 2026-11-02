import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Role } from '../src/models/Role.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { PERMISSIONS } from '../src/config/permissions.js';
import { staffToken } from './m4helpers.js';
import { randomGstin, randomMobile } from './helpers.js';

/**
 * 26 Oct — Registrations: Admin always holds every permission, whatever an
 * older server wrote to the role's row; the list can be searched and paged.
 */
const app = createApp();
let admin: { token: string; employeeId: string };

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
}, 60000);

describe('Admin holds every permission, whatever the database row says', () => {
  it('a shortened admin role (written by an older server) still signs Admin in with the approve rights', async () => {
    await Role.updateOne(
      { key: 'admin' },
      { $set: { permissionKeys: [PERMISSIONS.EMPLOYEE_READ] } },
    );
    const fresh = await staffToken(app, 'admin');
    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${fresh.token}`);
    expect(me.status).toBe(200);
    for (const p of [
      PERMISSIONS.BUYER_APPROVE,
      PERMISSIONS.SELLER_APPROVE,
      PERMISSIONS.LEADS_SEE_ALL,
    ]) {
      expect(me.body.data.permissions).toContain(p);
    }
  });
});

describe('Registrations list — search and pages', () => {
  const firmTag = `Searchable ${Date.now()}`;
  let gstin: string;
  let mobile: string;

  beforeAll(async () => {
    gstin = await randomGstin();
    mobile = randomMobile();
    const cp = await Counterparty.create({
      kind: 'buyer',
      status: 'pending',
      firm: `${firmTag} Agro`,
      gstin,
      pan: gstin.slice(2, 12),
      mobile,
    });
    await Buyer.create({ counterpartyId: cp._id });
    for (let i = 0; i < 3; i += 1) {
      const other = await Counterparty.create({
        kind: 'buyer',
        status: 'pending',
        firm: `${firmTag} Page ${i}`,
        mobile: randomMobile(),
      });
      await Buyer.create({ counterpartyId: other._id });
    }
  });

  const search = (q: string, extra = '') =>
    request(app)
      .get(`/api/v1/staff/registrations?stage=pending&q=${encodeURIComponent(q)}${extra}`)
      .set('Authorization', `Bearer ${admin.token}`);

  it('finds by part of the firm name, the GSTIN, or the mobile', async () => {
    for (const q of [`${firmTag} Agro`.toLowerCase(), gstin.slice(0, 9), mobile.slice(-6)]) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect((res.body.data as Array<{ firm: string }>).map((r) => r.firm)).toContain(
        `${firmTag} Agro`,
      );
    }
    const none = await search('no such firm anywhere');
    expect(none.body.data).toEqual([]);
  });

  it('pages: a cursor brings the next page, with no repeats', async () => {
    const first = await search(firmTag, '&limit=2');
    expect(first.body.data).toHaveLength(2);
    const cursor = first.body.meta.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    const second = await search(firmTag, `&limit=2&cursor=${cursor}`);
    expect(second.body.data).toHaveLength(2);
    const ids = [...first.body.data, ...second.body.data].map(
      (r: { registrationId: string }) => r.registrationId,
    );
    expect(new Set(ids).size).toBe(4);
    expect(second.body.meta.nextCursor).toBeUndefined();
  });
});
