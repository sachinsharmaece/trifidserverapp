import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { loginStaff, mfaSecretFor, randomEmail } from './helpers.js';

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
    const mfaSecret = mfaSecretFor(['admin']);
    await Employee.create({
      person: 'Query String Admin',
      email,
      passwordHash: await bcrypt.hash('CorrectHorse123', 10),
      roleIds: [adminRole!._id],
      mfaSecret,
      mfaEnabled: true,
      active: true,
    });

    const token = await loginStaff(app, email, 'CorrectHorse123', mfaSecret);

    const firstPage = await request(app)
      .get('/api/v1/admin/employees?limit=10')
      .set('Authorization', `Bearer ${token}`);
    expect(firstPage.status).toBe(200);
    expect(Array.isArray(firstPage.body.data)).toBe(true);

    // The suite shares one database across many test files, so by the time
    // this file runs there may be more than 10 employees — the one just
    // created here, with the newest _id, is not guaranteed to land on the
    // first page. Walk every page via `nextCursor` rather than assume it does.
    let found = firstPage.body.data.some((item: { email: string }) => item.email === email);
    let cursor: string | undefined = firstPage.body.meta.nextCursor;
    while (!found && cursor) {
      const page = await request(app)
        .get(`/api/v1/admin/employees?limit=10&cursor=${cursor}`)
        .set('Authorization', `Bearer ${token}`);
      found = page.body.data.some((item: { email: string }) => item.email === email);
      cursor = page.body.meta.nextCursor;
    }

    expect(found).toBe(true);
  });
});
