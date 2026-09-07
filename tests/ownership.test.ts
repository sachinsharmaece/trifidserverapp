import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { randomMobile } from './helpers.js';

const app = createApp();

function tokenFor(counterpartyId: string): string {
  return signAccessToken({
    sub: counterpartyId,
    actorType: 'counterparty',
    counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

describe('requireOwnership (CH §17.4 layer 2)', () => {
  it("cannot read another counterparty's file by editing the id in the request", async () => {
    const ownerCounterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'seller',
      status: 'active',
    });
    const attackerCounterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'buyer',
      status: 'active',
    });

    const ownerToken = tokenFor(ownerCounterparty.id as string);
    const attackerToken = tokenFor(attackerCounterparty.id as string);

    const uploadRes = await request(app)
      .post('/api/v1/files')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ mime: 'image/png', sizeBytes: 1024 });
    expect(uploadRes.status).toBe(201);
    const fileId = uploadRes.body.data.fileId as string;

    // The owner can read their own file.
    const ownerDownload = await request(app)
      .get(`/api/v1/files/${fileId}/download-url`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerDownload.status).toBe(200);

    // The attacker edits the file id in the URL to someone else's file.
    const attackerDownload = await request(app)
      .get(`/api/v1/files/${fileId}/download-url`)
      .set('Authorization', `Bearer ${attackerToken}`);
    expect(attackerDownload.status).toBe(404);
    expect(attackerDownload.body.error.code).toBe('NOT_VISIBLE');
  });
});
