import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { randomMobile } from './helpers.js';

const app = createApp();

describe('OTP brute force (CH §24.8 lockout)', () => {
  it('locks the mobile out after repeated wrong codes', async () => {
    const mobile = randomMobile();
    await Counterparty.create({ mobile, kind: 'buyer', status: 'active' });

    const requestRes = await request(app).post('/api/v1/auth/otp/request').send({ mobile });
    expect(requestRes.status).toBe(200);
    const { requestId, devCode } = requestRes.body.data as { requestId: string; devCode: string };

    const wrongCode = devCode === '111111' ? '222222' : '111111';

    let lastStatus = 0;
    let lastCode = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const verifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ requestId, code: wrongCode, deviceFingerprint: 'device-brute-force' });
      lastStatus = verifyRes.status;
      lastCode = verifyRes.body.error?.code;
      if (lastStatus === 423) break;
    }

    expect(lastStatus).toBe(423);
    expect(lastCode).toBe('LOCKED_OUT');

    // Locked out even with the *correct* code now.
    const correctAttempt = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ requestId, code: devCode, deviceFingerprint: 'device-brute-force' });
    expect(correctAttempt.status).toBe(423);
  });

  it('accepts a correct code on a fresh mobile and issues tokens', async () => {
    const mobile = randomMobile();
    await Counterparty.create({ mobile, kind: 'seller', status: 'active' });

    const requestRes = await request(app).post('/api/v1/auth/otp/request').send({ mobile });
    const { requestId, devCode } = requestRes.body.data as { requestId: string; devCode: string };

    const verifyRes = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ requestId, code: devCode, deviceFingerprint: 'device-happy-path' });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.accessToken).toBeTruthy();
    expect(verifyRes.body.data.me.kind).toBe('seller');
  });
});
