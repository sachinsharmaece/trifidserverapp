import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { randomMobile } from './helpers.js';

const app = createApp();

/**
 * TD-008 / CH §25.6 — the first wall sweep. There is a compile-time half of
 * this sweep too: shared/dto/identity.dto.ts ends with a type-level
 * assertion that fails `tsc --noEmit` outright if BuyerMeDto, SellerMeDto or
 * BothMeDto ever gains a `roles` or `permissions` field. This test is the
 * runtime half — it fails the build if a *response* ever carries one, even
 * if the type was (wrongly) widened to allow it.
 */
describe('wall sweep — no counterparty response carries a staff field', () => {
  it('GET /me for a buyer has no roles, permissions or mfaEnabled key', async () => {
    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'buyer',
      status: 'active',
    });
    const token = signAccessToken({
      sub: counterparty.id as string,
      actorType: 'counterparty',
      counterpartyId: counterparty.id as string,
      roles: [],
      permissions: [],
      status: 'active',
    });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('roles');
    expect(res.body.data).not.toHaveProperty('permissions');
    expect(res.body.data).not.toHaveProperty('mfaEnabled');
    expect(res.body.data.kind).toBe('buyer');
  });

  it('GET /me for a seller has no roles, permissions or mfaEnabled key', async () => {
    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'seller',
      status: 'active',
    });
    const token = signAccessToken({
      sub: counterparty.id as string,
      actorType: 'counterparty',
      counterpartyId: counterparty.id as string,
      roles: [],
      permissions: [],
      status: 'active',
    });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('roles');
    expect(res.body.data).not.toHaveProperty('permissions');
    expect(res.body.data).not.toHaveProperty('mfaEnabled');
    expect(res.body.data.kind).toBe('seller');
  });
});
