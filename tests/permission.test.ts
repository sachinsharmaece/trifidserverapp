import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { loginStaff, mfaSecretFor, randomEmail } from './helpers.js';

const app = createApp();

describe('requirePermission (TD-007)', () => {
  it('returns 403, not 500, for a staff user without the right permission', async () => {
    const email = randomEmail();
    const password = 'CorrectHorse123';
    const salesRole = await Role.findOne({ key: 'sales' });
    expect(salesRole).not.toBeNull();

    await Employee.create({
      person: 'Test Sales Person',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      roleIds: [salesRole!._id],
      mfaEnabled: false,
      active: true,
    });

    const loginRes = await request(app).post('/api/v1/auth/staff/login').send({ email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.mfaRequired).toBe(false);
    const token = loginRes.body.data.accessToken as string;

    // Sales has no config permissions in this session's ROLE_SEED.
    const configRes = await request(app)
      .get('/api/v1/admin/config')
      .set('Authorization', `Bearer ${token}`);

    expect(configRes.status).toBe(403);
    expect(configRes.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('lets an Admin through to the same route', async () => {
    const email = randomEmail();
    const password = 'CorrectHorse123';
    const adminRole = await Role.findOne({ key: 'admin' });

    const mfaSecret = mfaSecretFor(['admin']);
    await Employee.create({
      person: 'Test Admin Person',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      roleIds: [adminRole!._id],
      mfaSecret,
      mfaEnabled: true,
      active: true,
    });

    const token = await loginStaff(app, email, password, mfaSecret);

    const configRes = await request(app)
      .get('/api/v1/admin/config')
      .set('Authorization', `Bearer ${token}`);

    expect(configRes.status).toBe(200);
  });
});
