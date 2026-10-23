import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Lane } from '../src/models/Lane.js';
import { LaneAllocation } from '../src/models/LaneAllocation.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { AuthSession } from '../src/models/AuthSession.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Buyer } from '../src/models/Buyer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { forgetStaffActive } from '../src/shared/staffActive.js';
import { Role } from '../src/models/Role.js';
import { deactivateEmployee } from '../src/modules/admin/admin.team.js';
import { loginStaff, randomEmail, randomMobile } from './helpers.js';
import { staffToken } from './m4helpers.js';

const app = createApp();
const PASSWORD = 'CorrectHorse123';
const PAN = 'ABCPE1234F';
const AADHAAR = '234123412346';

let admin: { token: string; employeeId: string };
let founder: { token: string; employeeId: string };
let keyCounter = 0;
const key = () => `team-${Date.now()}-${(keyCounter += 1)}`;

function hr(overrides: Record<string, unknown> = {}) {
  return {
    dob: '1990-05-01',
    pan: PAN,
    aadhaar: AADHAAR,
    fatherName: 'Ramesh Kumar',
    fatherMobile: '',
    emergencyContact: { name: 'Sita Devi', relation: 'Mother', mobile: '+91 98765 43210' },
    permanentAddress: '12 MG Road, Indore',
    currentSameAsPermanent: true,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    person: 'Test Person',
    email: randomEmail(),
    mobile: randomMobile(),
    password: PASSWORD,
    roleKeys: [],
    positions: [],
    hr: hr(),
    ...overrides,
  };
}

function create(payload: Record<string, unknown>, token = admin.token) {
  return request(app)
    .post('/api/v1/admin/employees')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send(payload);
}

function update(employeeId: string, payload: Record<string, unknown>) {
  return request(app)
    .put(`/api/v1/admin/employees/${employeeId}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('Idempotency-Key', key())
    .send(payload);
}

const fieldsOf = (res: request.Response) =>
  Object.fromEntries(
    ((res.body.error?.fieldErrors ?? []) as { field: string; message: string }[]).map((fe) => [
      fe.field,
      fe.message,
    ]),
  );

/** Creates a leader (who reports to himself) and returns his id. */
async function createSalesLeader(): Promise<string> {
  const res = await create(
    body({
      person: 'Leader One',
      positions: ['SALES_LEADER', 'SALES_EXEC'],
      reportsToSalesLeaderId: 'self',
      reportsToPurchaseLeaderId: await purchaseLeaderId(),
    }),
  );
  expect(res.status).toBe(201);
  return res.body.data.employeeId as string;
}

let purchaseLeader: string | null = null;
async function purchaseLeaderId(): Promise<string> {
  if (purchaseLeader) return purchaseLeader;
  const res = await create(
    body({ person: 'Purchase Head', positions: ['PURCHASE_LEADER'], roleKeys: [] }),
  );
  expect(res.status).toBe(201);
  purchaseLeader = res.body.data.employeeId as string;
  return purchaseLeader;
}

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  founder = await staffToken(app, 'founder');
  // BR-262 — any employee save needs a full lane board; give it a holder.
  const holder = await Employee.findById(admin.employeeId);
  const lanes = await Lane.find();
  await LaneAllocation.create(lanes.map((l) => ({ laneKey: l.key, employeeId: holder!._id })));
});

describe('Create — HR fields and validation (check 4)', () => {
  it('saves with every mandatory HR field; the father’s mobile may be blank', async () => {
    const res = await create(body({ roleKeys: ['accounts'] }));
    expect(res.status).toBe(201);
    const saved = await Employee.findById(res.body.data.employeeId);
    expect(saved!.hr!.fatherMobile).toBeNull();
    expect(saved!.hr!.panLast4).toBe('234F');
    expect(saved!.hr!.panEncrypted).not.toContain(PAN);
    expect(saved!.hr!.aadhaarEncrypted).not.toContain(AADHAAR);
    expect(saved!.hr!.emergencyContact!.mobile).toBe('9876543210');
  });

  it('a wrong PAN, a bad Aadhaar checksum, an under-18 DOB and a bad mobile are each a field error', async () => {
    const res = await create(
      body({
        mobile: '12345',
        roleKeys: ['accounts'],
        hr: hr({ pan: 'AAPFU0939F', aadhaar: '234123412345', dob: '2015-01-01' }),
      }),
    );
    expect(res.status).toBe(400);
    const fields = fieldsOf(res);
    expect(fields.mobile).toMatch(/10-digit mobile/);
    expect(fields['hr.pan']).toMatch(/P as its 4th letter/);
    expect(fields['hr.aadhaar']).toMatch(/does not check out/);
    expect(fields['hr.dob']).toMatch(/at least 18/);
  });

  it('a mobile already on another employee is refused, naming him', async () => {
    const first = body({ person: 'Owner Of Number', roleKeys: ['accounts'] });
    expect((await create(first)).status).toBe(201);
    const res = await create(body({ mobile: first.mobile, roleKeys: ['accounts'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('mobile');
    expect(res.body.error.message_en).toMatch(/Owner Of Number/);
  });

  it('needs an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/v1/admin/employees')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(body({ roleKeys: ['accounts'] }));
    expect(res.body.error.field).toBe('Idempotency-Key');
  });
});

describe('Positions and reporting lines (check 5)', () => {
  it('a Sales Exec cannot be saved without a Sales Leader', async () => {
    const res = await create(body({ positions: ['SALES_EXEC'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('reportsToSalesLeaderId');
  });

  it('Sales Leader adds Purchase Exec, which then needs a Purchase Leader; positions add roles', async () => {
    const missing = await create(body({ positions: ['SALES_LEADER'] }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.field).toBe('reportsToPurchaseLeaderId');

    const res = await create(
      body({ positions: ['SALES_LEADER'], reportsToPurchaseLeaderId: await purchaseLeaderId() }),
    );
    expect(res.status).toBe(201);
    const saved = await request(app)
      .get(`/api/v1/admin/employees/${res.body.data.employeeId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(saved.body.data.positions).toEqual(['SALES_LEADER', 'PURCHASE_EXEC']);
    expect(saved.body.data.roleKeys.sort()).toEqual(['purchase', 'sales']);
    expect(saved.body.data.reportsToPurchaseLeader.person).toBe('Purchase Head');
  });

  it('a leader may report to himself; an executive may not', async () => {
    const leaderId = await createSalesLeader();
    const leader = await Employee.findById(leaderId);
    expect(String(leader!.reportsToSalesLeaderId)).toBe(leaderId);
    const exec = await create(body({ positions: ['SALES_EXEC'], reportsToSalesLeaderId: 'self' }));
    expect(exec.body.error.message_en).toMatch(/Only a Sales Leader/);
  });

  it('a leader cannot drop his position while people report to him', async () => {
    const leaderId = await createSalesLeader();
    const exec = await create(
      body({ positions: ['SALES_EXEC'], reportsToSalesLeaderId: leaderId }),
    );
    expect(exec.status).toBe(201);
    const leader = await request(app)
      .get(`/api/v1/admin/employees/${leaderId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    const res = await update(leaderId, {
      person: leader.body.data.person,
      email: leader.body.data.email,
      mobile: leader.body.data.mobile,
      roleKeys: ['sales'],
      positions: ['SALES_EXEC'],
      reportsToSalesLeaderId: await createSalesLeader(),
      hr: hr({ pan: undefined, aadhaar: undefined }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('positions');
    expect(res.body.error.message_en).toMatch(/Move them to another leader first/);
  });
});

describe('PII (check 6)', () => {
  let employeeId: string;
  beforeAll(async () => {
    const res = await create(body({ roleKeys: ['accounts'] }));
    employeeId = res.body.data.employeeId as string;
  });

  it('no list or detail response carries a full PAN or Aadhaar, for any reader', async () => {
    for (const reader of [admin, founder]) {
      for (const path of [
        '/api/v1/admin/employees?status=all',
        `/api/v1/admin/employees/${employeeId}`,
      ]) {
        const res = await request(app).get(path).set('Authorization', `Bearer ${reader.token}`);
        expect(res.status).toBe(200);
        const json = JSON.stringify(res.body);
        expect(json).not.toContain(PAN);
        expect(json).not.toContain(AADHAAR);
        expect(json).not.toMatch(/panEncrypted|aadhaarEncrypted/);
      }
    }
    const detail = await request(app)
      .get(`/api/v1/admin/employees/${employeeId}`)
      .set('Authorization', `Bearer ${founder.token}`);
    expect(detail.body.data.hr).toMatchObject({
      panMasked: 'XXXXXX234F',
      aadhaarMasked: 'XXXX XXXX 2346',
    });
  });

  it('only Admin reveals the full value, and each reveal is audited', async () => {
    const denied = await request(app)
      .post(`/api/v1/admin/employees/${employeeId}/reveal`)
      .set('Authorization', `Bearer ${founder.token}`)
      .send({ field: 'pan' });
    expect(denied.status).toBe(403);
    const res = await request(app)
      .post(`/api/v1/admin/employees/${employeeId}/reveal`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ field: 'aadhaar' });
    expect(res.body.data).toEqual({ field: 'aadhaar', value: AADHAAR });
    const audit = await AuditLog.findOne({ entityId: employeeId, field: 'pii_reveal' });
    expect(audit?.reason).toBe('Revealed Aadhaar');
    expect(JSON.stringify(audit)).not.toContain(AADHAAR);
  });
});

describe('Edit (check 7)', () => {
  it('a blank password keeps the current one; PAN and Aadhaar left out keep theirs', async () => {
    const payload = body({ roleKeys: ['accounts'] });
    const created = await create(payload);
    const employeeId = created.body.data.employeeId as string;
    const res = await update(employeeId, {
      ...payload,
      person: 'Renamed Person',
      password: '',
      hr: hr({ pan: undefined, aadhaar: undefined }),
    });
    expect(res.status).toBe(200);
    const token = await loginStaff(app, payload.email, PASSWORD);
    expect(token).toEqual(expect.any(String));
    const saved = await Employee.findById(employeeId);
    expect(saved!.person).toBe('Renamed Person');
    expect(saved!.hr!.panLast4).toBe('234F');
    expect(await AuditLog.countDocuments({ entityId: employeeId, field: 'edit' })).toBe(1);
  });
});

describe('Switch off and on (check 8)', () => {
  it('forces a hand-over, moves buyers, lanes and reports in one go, and locks the person out', async () => {
    const leaderId = await createSalesLeader();
    const payload = body({ positions: ['SALES_EXEC'], reportsToSalesLeaderId: leaderId });
    const exec = await create(payload);
    const execId = exec.body.data.employeeId as string;
    const execToken = await loginStaff(app, payload.email, PASSWORD);

    // He owns a buyer and holds a lane.
    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'buyer',
      status: 'active',
    });
    const buyer = await Buyer.create({ counterpartyId: counterparty._id });
    await BookAssignment.create({
      buyerId: buyer._id,
      ownerEmployeeId: execId,
      assignedAt: new Date(),
      assignedBy: admin.employeeId,
    });
    await LaneAllocation.updateOne({ laneKey: 'B1' }, { $set: { employeeId: execId } });

    const impact = await request(app)
      .get(`/api/v1/admin/employees/${execId}/deactivation-impact`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(impact.body.data).toMatchObject({
      buyersOwned: 1,
      laneKeys: ['B1'],
      needsReassign: true,
      defaultReassignTo: { employeeId: leaderId, person: 'Leader One' },
    });

    const noTarget = await request(app)
      .post(`/api/v1/admin/employees/${execId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key())
      .send({});
    expect(noTarget.body.error.field).toBe('reassignToEmployeeId');

    const res = await request(app)
      .post(`/api/v1/admin/employees/${execId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key())
      .send({ reassignToEmployeeId: leaderId, reason: 'Left the company' });
    expect(res.status).toBe(200);

    expect(String((await BookAssignment.findOne({ buyerId: buyer._id }))!.ownerEmployeeId)).toBe(
      leaderId,
    );
    expect(String((await LaneAllocation.findOne({ laneKey: 'B1' }))!.employeeId)).toBe(leaderId);
    expect(await AuthSession.countDocuments({ employeeId: execId, revokedAt: null })).toBe(0);

    // His live token stops working, and he cannot sign in.
    const live = await request(app)
      .get('/api/v1/staff/sales/buyers')
      .set('Authorization', `Bearer ${execToken}`);
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    const login = await request(app)
      .post('/api/v1/auth/staff/login')
      .send({ email: payload.email, password: PASSWORD });
    expect(login.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');

    // He is gone from the "active" list every dropdown uses.
    const active = await request(app)
      .get('/api/v1/admin/employees?status=active')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(active.body.data.map((e: { employeeId: string }) => e.employeeId)).not.toContain(execId);
    // And cannot be picked as someone's leader or cover.
    const asLeader = await create(
      body({ positions: ['SALES_EXEC'], reportsToSalesLeaderId: execId }),
    );
    expect(asLeader.body.error.field).toBe('reportsToSalesLeaderId');

    const back = await request(app)
      .post(`/api/v1/admin/employees/${execId}/reactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key());
    expect(back.status).toBe(200);
    forgetStaffActive(execId);
    expect(await loginStaff(app, payload.email, PASSWORD)).toEqual(expect.any(String));
    expect(
      await AuditLog.countDocuments({
        entityId: execId,
        field: { $in: ['deactivate', 'reactivate'] },
      }),
    ).toBe(2);
  });

  it('nobody switches himself off, and the last Admin or Founder stays on', async () => {
    const self = await request(app)
      .post(`/api/v1/admin/employees/${admin.employeeId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key())
      .send({});
    expect(self.body.error.message_en).toMatch(/cannot switch yourself off/);

    // Leave one Admin standing: switch the founder and every other Admin
    // off, then ask the service (as any other actor) to switch the last one
    // off. Through the API only an Admin can act, so the last Admin can only
    // ever be himself — that is the self check above; this is the backstop.
    await LaneAllocation.updateMany({}, { $set: { employeeId: admin.employeeId } });
    const guardRoles = await Role.find({ key: { $in: ['admin', 'founder'] } });
    await Employee.updateMany(
      { _id: { $ne: admin.employeeId }, roleIds: { $in: guardRoles.map((r) => r._id) } },
      { $set: { active: false } },
    );
    await expect(
      deactivateEmployee(
        admin.employeeId,
        {},
        { employeeId: founder.employeeId, correlationId: 't' },
      ),
    ).rejects.toMatchObject({
      field: 'employeeId',
      messageEn: expect.stringMatching(/last active Admin or Founder/),
    });
  });
});
