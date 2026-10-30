import { describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { randomEmail, randomMobile } from './helpers.js';

/**
 * 27 Oct — a staff lockout that has run out starts the count again. Before,
 * the counter stayed at the limit, so one typo after the lockout ended locked
 * the person out for another 30 minutes.
 */
const app = createApp();
const PASSWORD = 'CorrectHorse123';

const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/staff/login').send({ email, password });

describe('Staff lockout', () => {
  it('locks after the limit; once the lock has run out, one typo is just a typo', async () => {
    const role = await Role.findOne({ key: 'sales' });
    const email = randomEmail();
    const employee = await Employee.create({
      person: 'Lockout Person',
      email,
      mobile: randomMobile(),
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      roleIds: [role!._id],
      active: true,
    });

    for (let i = 0; i < env.staffLockoutAttempts; i += 1) {
      expect((await login(email, 'wrong-password')).body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect((await login(email, PASSWORD)).body.error.code).toBe('LOCKED_OUT');

    // The lockout runs out (moved into the past rather than waiting 30 minutes).
    await Employee.updateOne(
      { _id: employee._id },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );

    const typo = await login(email, 'wrong-password');
    expect(typo.body.error.code).toBe('INVALID_CREDENTIALS');
    const after = await Employee.findById(employee._id);
    expect(after!.failedLoginAttempts).toBe(1);
    expect(after!.lockedUntil).toBeNull();

    const ok = await login(email, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
  });
});
