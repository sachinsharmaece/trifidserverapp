import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { loginStaff, mfaSecretFor, randomEmail, randomGstin, randomMobile } from './helpers.js';
import { locationFor, purchaseLeader, salesLeader } from './buyerHelpers.js';

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

    const leader = await salesLeader(app);
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ category: 'Dealer', assignedToEmployeeId: leader.employeeId }); // no location

    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error.code).toBe('VALIDATION_FAILED');
  });

  // Phase 3 (F1) — a Sales executive used to approve buyers, and could approve
  // sellers too. Now a buyer needs a Sales Leader (or Admin).
  it('a Sales executive without the leader position cannot approve a buyer', async () => {
    const registerRes = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({
        mobile: randomMobile(),
        firm: 'Not Yours Traders',
        gstin: await randomGstin(),
        ownerName: 'Owner Name',
        licenceNo: 'LIC-125',
        gstPpobAddress: 'Some address',
        bankDetail: bankDetail(),
        consent: consent(),
      });
    const tehsil = await Tehsil.create({
      name: `Test Tehsil ${Date.now()}-x`,
      district: 'Test District',
      state: 'MP',
    });
    const token = await staffToken('sales');
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registerRes.body.data.registrationId}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        category: 'Dealer',
        location: await locationFor((tehsil._id as unknown as string).toString()),
        assignedToEmployeeId: (await salesLeader(app)).employeeId,
      });
    expect(approveRes.status).toBe(403);
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

    const leader = await salesLeader(app);
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        category: 'Dealer',
        location: await locationFor((tehsil._id as unknown as string).toString()),
        assignedToEmployeeId: leader.employeeId,
      });

    expect(approveRes.status).toBe(200);

    const statusRes = await request(app)
      .get(`/api/v1/registrations/${registrationId}`)
      .set('Authorization', `Bearer ${leader.token}`);
    expect(statusRes.body.data.status).toBe('active');
    const buyer = await Buyer.findOne({ counterpartyId: registrationId });
    expect(buyer!.category).toBe('Dealer');
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

    // Phase 4 — sellers are decided by a Purchase Leader; a plain Purchase
    // user is refused before the body is even read.
    const token = await staffToken('purchase');
    const byExec = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tehsilIds: [], dispatchCutoffTime: '16:00' });
    expect(byExec.status).toBe(403);

    const leader = await purchaseLeader(app);
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        tehsilIds: [],
        dispatchCutoffTime: '16:00',
        assignedToEmployeeId: leader.employeeId,
      });

    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'tehsilIds' })]),
    );
  });

  // Regression — B-50: the approval panel showed neither a firm name nor a
  // GSTIN, a real risk of approving the wrong registration when several are
  // open. `getRegistration` (API-012) now carries both.
  it('the registration read carries firm and GSTIN, for the approval panel to show', async () => {
    const gstin = await randomGstin();
    const registerRes = await request(app).post('/api/v1/registrations/buyer').send({
      mobile: randomMobile(),
      firm: 'Identify Me Traders',
      gstin,
      ownerName: 'Owner Name',
      licenceNo: 'LIC-300',
      gstPpobAddress: 'Some address',
      bankDetail: bankDetail(),
      consent: consent(),
    });
    expect(registerRes.status).toBe(201);
    const registrationId = registerRes.body.data.registrationId;

    const token = await staffToken('sales');
    const statusRes = await request(app)
      .get(`/api/v1/registrations/${registrationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.firm).toBe('Identify Me Traders');
    expect(statusRes.body.data.gstin).toBe(gstin);
  });

  // Regression — B-28: a buyer with a blank firm name or GSTIN should never
  // reach `active`. Registration-time validation already requires both;
  // this is the backstop for a record written outside that path (a data
  // artifact, or a future direct write), so the raw driver is used here to
  // create one — a normal `.create()` would itself refuse a blank firm/GSTIN
  // at the schema level, which is not what this is testing.
  it('refuses to approve a buyer with a blank firm', async () => {
    const tehsil = await Tehsil.create({
      name: `Test Tehsil ${Date.now()}-${Math.random()}`,
      district: 'Test District',
      state: 'MP',
    });
    const counterpartyId = new Types.ObjectId();
    await Counterparty.collection.insertOne({
      _id: counterpartyId,
      mobile: randomMobile(),
      firm: '',
      gstin: '',
      ownerName: 'Owner Name',
      licenceNo: 'LIC-400',
      kind: 'buyer',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await Buyer.create({ counterpartyId, gstPpobAddress: 'Some address' });

    const leader = await salesLeader(app);
    const approveRes = await request(app)
      .post(`/api/v1/staff/registrations/${counterpartyId.toString()}/approve`)
      .set('Idempotency-Key', `decide-${Date.now()}-${Math.random()}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        category: 'Dealer',
        location: await locationFor((tehsil._id as unknown as string).toString()),
        assignedToEmployeeId: leader.employeeId,
      });

    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error.message_en).toMatch(/no firm name/);
  });
});
