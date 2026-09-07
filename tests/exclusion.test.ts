import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Seller } from '../src/models/Seller.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { randomGstin, randomMobile } from './helpers.js';

const app = createApp();

async function sellerToken(): Promise<string> {
  const counterparty = await Counterparty.create({
    mobile: randomMobile(),
    kind: 'seller',
    status: 'active',
  });
  await Seller.create({ counterpartyId: counterparty._id });
  return signAccessToken({
    sub: counterparty.id as string,
    actorType: 'counterparty',
    counterpartyId: counterparty.id as string,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

describe('Exclusions (BR-089, BR-090)', () => {
  it('caps a seller at 20 active blocks, returning 409 on the 21st', async () => {
    const token = await sellerToken();

    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const gstin = await randomGstin();
      const res = await request(app)
        .post('/api/v1/exclusions')
        .set('Authorization', `Bearer ${token}`)
        .send({ gstin });
      lastStatus = res.status;
      if (res.status !== 201) break;
    }

    expect(lastStatus).toBe(409);
  });

  it('rejects a create request that also sends a reason field', async () => {
    const token = await sellerToken();
    const res = await request(app)
      .post('/api/v1/exclusions')
      .set('Authorization', `Bearer ${token}`)
      .send({ gstin: await randomGstin(), reason: 'competitor' });

    expect(res.status).toBe(400);
  });

  it('never stores a name-searchable list — lookup only confirms a supplied GSTIN', async () => {
    const token = await sellerToken();
    const res = await request(app)
      .post('/api/v1/exclusions/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({ gstin: await randomGstin() });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ exists: false });
  });

  it('rate-limits a burst of lookups from the same seller (BR-089 — a GSTIN-enumeration oracle)', async () => {
    const token = await sellerToken();

    let lastStatus = 0;
    // The per-seller cap is 30 lookups per hour (middleware/rateLimit.ts via
    // exclusion.service.ts) — 35 calls guarantees crossing it.
    for (let i = 0; i < 35; i += 1) {
      const res = await request(app)
        .post('/api/v1/exclusions/lookup')
        .set('Authorization', `Bearer ${token}`)
        .send({ gstin: await randomGstin() });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);
  });
});
