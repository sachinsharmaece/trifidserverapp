import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { loginStaff, mfaSecretFor, randomEmail, randomGstin, randomMobile } from './helpers.js';

const app = createApp();

async function staffToken(roleKey: string): Promise<string> {
  const email = randomEmail();
  const password = 'CorrectHorse123';
  const role = await Role.findOne({ key: roleKey });
  const mfaSecret = mfaSecretFor([roleKey]);
  await Employee.create({
    person: 'Test Staff',
    email,
    passwordHash: await bcrypt.hash(password, 10),
    roleIds: [role!._id],
    mfaSecret: mfaSecret ?? null,
    mfaEnabled: mfaSecret !== undefined,
    active: true,
  });
  return loginStaff(app, email, password, mfaSecret);
}

function bankDetail() {
  return { accountNumber: '123456789012', ifsc: 'HDFC0001234', accountName: 'Test Account' };
}

function consent() {
  return { noticeVersion: 'v1', marketingOptIn: false };
}

describe('Registration approval gates (BR-081, BR-083)', () => {
  it('rejects approving a buyer without a tehsil', async () => {
    const registerRes = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({
        mobile: randomMobile(),
        firm: 'Test Buyer Firm',
        gstin: await randomGstin(),
        ownerName: 'Owner Name',
        licenceNo: 'LIC-123',
        gstPpobAddress: 'Some address',
        bankDetail: bankDetail(),
        consent: consent(),
      });
    expect(registerRes.status).toBe(201);
    const registrationId = registerRes.body.data.registrationId;

    const token = await staffToken('sales');
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tradePosition: 'dealer', isTrader: false }); // no tehsilId

    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('approves a buyer once a tehsil is supplied', async () => {
    const tehsil = await Tehsil.create({
      name: `Test Tehsil ${Date.now()}`,
      district: 'Test District',
      state: 'MP',
    });
    const registerRes = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({
        mobile: randomMobile(),
        firm: 'Test Buyer Firm 2',
        gstin: await randomGstin(),
        ownerName: 'Owner Name',
        licenceNo: 'LIC-124',
        gstPpobAddress: 'Some address',
        bankDetail: bankDetail(),
        consent: consent(),
      });
    expect(registerRes.status).toBe(201);
    const registrationId = registerRes.body.data.registrationId;

    const token = await staffToken('sales');
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        tehsilId: (tehsil._id as unknown as string).toString(),
        tradePosition: 'dealer',
        isTrader: false,
      });

    expect(approveRes.status).toBe(200);

    const statusRes = await request(app)
      .get(`/api/v1/registrations/${registrationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(statusRes.body.data.status).toBe('active');
  });

  it('rejects approving a seller without an area', async () => {
    const registerRes = await request(app)
      .post('/api/v1/registrations/seller')
      .send({
        mobile: randomMobile(),
        firm: 'Test Seller Firm',
        gstin: await randomGstin(),
        ownerName: 'Owner Name',
        licenceNo: 'LIC-200',
        references: [
          {
            firm: 'Ref One',
            phone: '9000000001',
            relationship: 'Supplier',
            whatTheySaid: 'Reliable',
          },
          {
            firm: 'Ref Two',
            phone: '9000000002',
            relationship: 'Buyer',
            whatTheySaid: 'Pays on time',
          },
        ],
        bankDetail: bankDetail(),
        consent: consent(),
      });
    expect(registerRes.status).toBe(201);
    const registrationId = registerRes.body.data.registrationId;

    const token = await staffToken('purchase');
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tehsilIds: [], dispatchCutoffTime: '16:00' });

    expect(approveRes.status).toBe(400);
  });
});
