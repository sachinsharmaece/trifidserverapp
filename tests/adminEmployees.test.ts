import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { randomEmail } from './helpers.js';

const app = createApp();

/**
 * Regression test — Express 5 makes `req.query` getter-only, so
 * `validateQuery` (middleware/validate.ts) must attach the parsed query to
 * `req.validatedQuery` rather than reassigning `req.query`. This is also the
 * exact endpoint trifid-adminapp's one live screen (the employee list)
 * calls, so it doubles as proof that call works end to end.
 */
describe('GET /admin/employees', () => {
  it('lists employees with a query string present, without a 500', async () => {
    const email = randomEmail();
    const adminRole = await Role.findOne({ key: 'admin' });
    await Employee.create({
      person: 'Query String Admin',
      email,
      passwordHash: await bcrypt.hash('CorrectHorse123', 10),
      roleIds: [adminRole!._id],
      mfaEnabled: false,
      active: true,
    });

    const loginRes = await request(app)
      .post('/api/v1/auth/staff/login')
      .send({ email, password: 'CorrectHorse123' });
    const token = loginRes.body.data.accessToken as string;

    const listRes = await request(app)
      .get('/api/v1/admin/employees?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.some((item: { email: string }) => item.email === email)).toBe(true);
  });
});
