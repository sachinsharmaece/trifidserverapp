import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Seller } from '../src/models/Seller.js';
import { SellerArea } from '../src/models/SellerArea.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { randomGstin, randomMobile } from './helpers.js';

const app = createApp();

/**
 * Wall sweep, extended for M3 (BR-064, CH §3.12) — no seller-facing response
 * anywhere in this milestone's endpoints carries a tehsil or district name,
 * except the seller's own area page, which is the one sanctioned exception.
 */
describe('wall sweep — seller-facing territory data', () => {
  it("GET /me/area is the sanctioned exception — it does show the seller's own tehsils", async () => {
    const tehsil = await Tehsil.create({
      name: `WallSweep Tehsil ${Date.now()}`,
      district: 'WallSweep District',
      state: 'MP',
    });
    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'seller',
      status: 'active',
    });
    const seller = await Seller.create({ counterpartyId: counterparty._id });
    await SellerArea.create({
      sellerId: seller._id,
      tehsilId: tehsil._id,
      setBy: counterparty._id,
      setAt: new Date(),
    });

    const token = signAccessToken({
      sub: counterparty.id as string,
      actorType: 'counterparty',
      counterpartyId: counterparty.id as string,
      roles: [],
      permissions: [],
      status: 'active',
    });

    const res = await request(app).get('/api/v1/me/area').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tehsils[0].name).toBe(tehsil.name);
  });

  it('exclusion responses never carry a tehsil or district field', async () => {
    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'seller',
      status: 'active',
    });
    await Seller.create({ counterpartyId: counterparty._id });
    const token = signAccessToken({
      sub: counterparty.id as string,
      actorType: 'counterparty',
      counterpartyId: counterparty.id as string,
      roles: [],
      permissions: [],
      status: 'active',
    });

    await request(app)
      .post('/api/v1/exclusions')
      .set('Authorization', `Bearer ${token}`)
      .send({ gstin: await randomGstin() });

    const listRes = await request(app)
      .get('/api/v1/exclusions')
      .set('Authorization', `Bearer ${token}`);
    const serialized = JSON.stringify(listRes.body.data).toLowerCase();
    expect(serialized).not.toContain('tehsil');
    expect(serialized).not.toContain('district');

    const lookupRes = await request(app)
      .post('/api/v1/exclusions/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({ gstin: await randomGstin() });
    const lookupSerialized = JSON.stringify(lookupRes.body.data).toLowerCase();
    expect(lookupSerialized).not.toContain('tehsil');
    expect(lookupSerialized).not.toContain('district');
  });
});
