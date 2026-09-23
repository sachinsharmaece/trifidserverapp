import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { generate } from 'otplib';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { AuthSession } from '../src/models/AuthSession.js';
import { Role } from '../src/models/Role.js';
import { loginStaff, mfaSecretFor, randomEmail } from './helpers.js';
import { staffToken } from './m4helpers.js';

/**
 * M10 — MFA is enforced by ROLE (CH §24.3), not by the `mfaEnabled` data flag.
 * Before this, a Controller, Admin or Founder whose flag was off signed in on a
 * password alone.
 */
const app = createApp();
const PASSWORD = 'CorrectHorse123';

async function makeEmployee(roleKey: string, opts: { secret?: string; flag: boolean }) {
  const role = await Role.findOne({ key: roleKey });
  const email = randomEmail();
  const employee = await Employee.create({
    person: `MFA ${roleKey}`,
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    roleIds: [role!._id],
    mfaSecret: opts.secret ?? null,
    mfaEnabled: opts.flag,
    active: true,
  });
  return { email, employeeId: (employee._id as unknown as string).toString() };
}

const signIn = (email: string) =>
  request(app).post('/api/v1/auth/staff/login').send({ email, password: PASSWORD });

describe('MFA is enforced by role, not by a data flag', () => {
  for (const roleKey of ['controller', 'admin', 'founder']) {
    it(`${roleKey} with the flag off and no authenticator is REFUSED, not let in on a password`, async () => {
      const { email } = await makeEmployee(roleKey, { flag: false });
      const res = await signIn(email);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
      expect(res.body.data?.accessToken).toBeUndefined();
    });
  }

  it('the flag being off does not switch the challenge off when a secret exists', async () => {
    const secret = mfaSecretFor(['controller'])!;
    const { email } = await makeEmployee('controller', { secret, flag: false });
    const res = await signIn(email);
    expect(res.status).toBe(200);
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('a wrong authenticator code is refused; the right one signs in', async () => {
    const secret = mfaSecretFor(['admin'])!;
    const { email } = await makeEmployee('admin', { secret, flag: true });
    const login = await signIn(email);
    const wrong = await request(app)
      .post('/api/v1/auth/staff/mfa/verify')
      .send({ mfaToken: login.body.data.mfaToken, code: '000000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body.data?.accessToken).toBeUndefined();
    expect(await loginStaff(app, email, PASSWORD, secret)).toBeTruthy();
  });

  it('every other role still signs in on a password, unchanged', async () => {
    for (const roleKey of ['sales', 'purchase', 'accounts', 'transport_logistics']) {
      const { email } = await makeEmployee(roleKey, { flag: false });
      const res = await signIn(email);
      expect(res.status, roleKey).toBe(200);
      expect(res.body.data.mfaRequired).toBe(false);
      expect(res.body.data.accessToken).toBeTruthy();
    }
  });

  it('re-authentication also demands the code from these roles, whatever the flag says', async () => {
    const secret = mfaSecretFor(['controller'])!;
    const { email } = await makeEmployee('controller', { secret, flag: false });
    const token = await loginStaff(app, email, PASSWORD, secret);
    const noCode = await request(app)
      .post('/api/v1/auth/reauth')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD });
    expect(noCode.status).toBe(401);
    const withCode = await request(app)
      .post('/api/v1/auth/reauth')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD, mfaCode: await generate({ secret }) });
    expect(withCode.status).toBe(200);
  });
});

describe('the enrolment path — an Admin issues the authenticator', () => {
  async function adminWithReauth() {
    const secret = mfaSecretFor(['admin'])!;
    const { email, employeeId } = await makeEmployee('admin', { secret, flag: true });
    const token = await loginStaff(app, email, PASSWORD, secret);
    const reauth = await request(app)
      .post('/api/v1/auth/reauth')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD, mfaCode: await generate({ secret }) });
    return { token, employeeId, reauthToken: reauth.body.data.reauthToken as string };
  }

  it('issues a secret that then works end to end, and refuses without re-authentication', async () => {
    const admin = await adminWithReauth();
    const target = await makeEmployee('controller', { flag: false });

    const noReauth = await request(app)
      .post(`/api/v1/admin/employees/${target.employeeId}/mfa`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(noReauth.status).toBe(401);
    expect(noReauth.body.error.code).toBe('REAUTH_REQUIRED');

    const issued = await request(app)
      .post(`/api/v1/admin/employees/${target.employeeId}/mfa`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-Reauth-Token', admin.reauthToken);
    expect(issued.status).toBe(201);
    const secret = issued.body.data.mfaSecret as string;
    expect(issued.body.data.mfaOtpauthUrl).toContain('otpauth://');

    expect(await loginStaff(app, target.email, PASSWORD, secret)).toBeTruthy();
  }, 30000);

  it('re-issuing kills the old secret and signs the person out everywhere', async () => {
    const admin = await adminWithReauth();
    const oldSecret = mfaSecretFor(['controller'])!;
    const target = await makeEmployee('controller', { secret: oldSecret, flag: true });
    await loginStaff(app, target.email, PASSWORD, oldSecret); // creates a session

    const issued = await request(app)
      .post(`/api/v1/admin/employees/${target.employeeId}/mfa`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-Reauth-Token', admin.reauthToken);
    expect(issued.status).toBe(201);
    expect(issued.body.data.mfaSecret).not.toBe(oldSecret);

    const live = await AuthSession.countDocuments({
      employeeId: target.employeeId,
      revokedAt: null,
    });
    expect(live).toBe(0);
    const login = await signIn(target.email);
    const stale = await request(app)
      .post('/api/v1/auth/staff/mfa/verify')
      .send({ mfaToken: login.body.data.mfaToken, code: await generate({ secret: oldSecret }) });
    expect(stale.body.data?.accessToken).toBeUndefined();
  }, 30000);

  it('refuses a role that does not use MFA, and a caller without employee:write', async () => {
    const admin = await adminWithReauth();
    const sales = await makeEmployee('sales', { flag: false });
    const notMfaRole = await request(app)
      .post(`/api/v1/admin/employees/${sales.employeeId}/mfa`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-Reauth-Token', admin.reauthToken);
    expect(notMfaRole.status).toBe(400);

    const salesCaller = await staffToken(app, 'sales');
    const denied = await request(app)
      .post(`/api/v1/admin/employees/${sales.employeeId}/mfa`)
      .set('Authorization', `Bearer ${salesCaller.token}`);
    expect(denied.status).toBe(403);
  }, 30000);
});
