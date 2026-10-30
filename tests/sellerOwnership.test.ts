import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Seller } from '../src/models/Seller.js';
import { SellerAssignment } from '../src/models/SellerAssignment.js';
import { LaneAllocation } from '../src/models/LaneAllocation.js';
import { Lane } from '../src/models/Lane.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { BankDetail } from '../src/models/BankDetail.js';
import { SellerReference } from '../src/models/SellerReference.js';
import { loginStaff, randomEmail, randomGstin, randomMobile } from './helpers.js';
import { locationFor, type TestLocation } from './buyerHelpers.js';
import { staffToken } from './m4helpers.js';

const app = createApp();
const PASSWORD = 'CorrectHorse123';
let keyCounter = 0;
const key = () => `seller-${Date.now()}-${(keyCounter += 1)}`;

interface Staff {
  token: string;
  employeeId: string;
}

async function person(
  name: string,
  roleKeys: string[],
  positions: string[],
  reportsTo: { sales?: string | 'self'; purchase?: string | 'self' } = {},
): Promise<Staff> {
  const roles = await Role.find({ key: { $in: roleKeys } });
  const email = randomEmail();
  const e = await Employee.create({
    person: name,
    email,
    mobile: randomMobile(),
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    roleIds: roles.map((r) => r._id),
    positions,
    active: true,
  });
  if (reportsTo.sales)
    e.reportsToSalesLeaderId = (reportsTo.sales === 'self' ? e._id : reportsTo.sales) as never;
  if (reportsTo.purchase) {
    e.reportsToPurchaseLeaderId = (
      reportsTo.purchase === 'self' ? e._id : reportsTo.purchase
    ) as never;
  }
  await e.save();
  return { token: await loginStaff(app, email, PASSWORD), employeeId: String(e._id) };
}

let leaderP: Staff;
let execP: Staff;
let leaderQ: Staff;
let salesLeader: Staff;
let admin: Staff;
let home: TestLocation;
let areaId: string;

function addSeller(token: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/staff/registrations/seller')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({
      mobile: randomMobile(),
      firm: `Seller ${Math.random()}`,
      ownerName: 'Owner',
      licenceNo: 'MP/IND/INS/2016/0771',
      references: [
        { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Good' },
        { firm: 'Ref Two', phone: '9000000002', relationship: 'Supplier', whatTheySaid: 'Good' },
      ],
      bankDetail: { accountNumber: '000900012345678', ifsc: 'HDFC0001234', accountName: 'Owner' },
      consent: { noticeVersion: 'v1', marketingOptIn: false },
      callNote: 'On a call.',
      location: home,
      proprietorAgreed: true,
      ...body,
    });
}

const sellerOf = async (registrationId: string) =>
  (await Seller.findOne({ counterpartyId: registrationId }))!;
const ownerOf = async (sellerId: unknown) =>
  (await SellerAssignment.findOne({ sellerId }))?.ownerEmployeeId?.toString() ?? null;

function approve(token: string, registrationId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({ tehsilIds: [areaId], dispatchCutoffTime: '16:00', ...body });
}

beforeAll(async () => {
  leaderP = await person('Purchase Leader P', ['purchase'], ['PURCHASE_LEADER', 'PURCHASE_EXEC'], {
    purchase: 'self',
  });
  execP = await person('Purchase Exec P', ['purchase'], ['PURCHASE_EXEC'], {
    purchase: leaderP.employeeId,
  });
  leaderQ = await person('Purchase Leader Q', ['purchase'], ['PURCHASE_LEADER', 'PURCHASE_EXEC'], {
    purchase: 'self',
  });
  salesLeader = await person(
    'Sales Leader S',
    ['sales', 'purchase'],
    ['SALES_LEADER', 'SALES_EXEC', 'PURCHASE_EXEC'],
    { sales: 'self', purchase: leaderP.employeeId },
  );
  admin = await staffToken(app, 'admin');
  const homeTehsil = await Tehsil.create({
    name: `Home ${Date.now()}`,
    district: 'D',
    state: 'MP',
  });
  home = await locationFor(String(homeTehsil._id));
  areaId = String(
    (await Tehsil.create({ name: `Area ${Date.now()}`, district: 'D', state: 'MP' }))._id,
  );
});

describe('Add a seller — licence, bank and referees optional on the staff form (DEC-069)', () => {
  it('registers him without them, and he can be approved', async () => {
    const res = await addSeller(execP.token, {
      gstin: await randomGstin(),
      licenceNo: '',
      bankDetail: undefined,
      references: undefined,
    });
    expect(res.status).toBe(201);
    const id = res.body.data.registrationId as string;
    expect((await Counterparty.findById(id))!.licenceNo ?? null).toBeNull();
    expect(await BankDetail.countDocuments({ counterpartyId: id })).toBe(0);
    expect(await SellerReference.countDocuments({ sellerId: (await sellerOf(id))._id })).toBe(0);
    const ok = await approve(leaderP.token, id, { assignedToEmployeeId: execP.employeeId });
    expect(ok.status).toBe(200);
  });

  it('still checks what is given: one referee is fine, a referee without a phone is not', async () => {
    const one = await addSeller(execP.token, {
      gstin: await randomGstin(),
      references: [
        { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Good' },
      ],
    });
    expect(one.status).toBe(201);
    const noPhone = await addSeller(execP.token, {
      gstin: await randomGstin(),
      references: [{ firm: 'Ref One', phone: '', relationship: 'Supplier', whatTheySaid: 'Good' }],
    });
    expect(noPhone.status).toBe(400);
    const badLicence = await addSeller(execP.token, {
      gstin: await randomGstin(),
      licenceNo: 'AB',
    });
    expect(badLicence.status).toBe(400);
  });

  it("the seller app's own registration still requires them", async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send({
        mobile: randomMobile(),
        firm: 'App Seller',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      });
    expect(res.status).toBe(400);
  });
});

describe('Add a seller (check 18)', () => {
  it('needs his location; saves location, Marg code and the assignee; no OTP', async () => {
    const noLocation = await addSeller(execP.token, {
      gstin: await randomGstin(),
      location: undefined,
    });
    expect(noLocation.status).toBe(400);
    expect(noLocation.body.error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'location' })]),
    );

    const res = await addSeller(execP.token, {
      gstin: await randomGstin(),
      margPartyCode: 'sup-01',
      location: { ...home, pincode: '456010' },
    });
    expect(res.status).toBe(201);
    const seller = await sellerOf(res.body.data.registrationId);
    expect(String(seller.tehsilId)).toBe(home.tehsilId);
    expect(seller.margPartyCode).toBe('SUP-01');
    expect(seller.pincode).toBe('456010');
    expect(await ownerOf(seller._id)).toBe(execP.employeeId);
  });

  it('refuses a duplicate Marg code and a GSTIN from another state', async () => {
    await addSeller(execP.token, { gstin: await randomGstin(), margPartyCode: 'SUP-77' });
    const dup = await addSeller(execP.token, {
      gstin: await randomGstin(),
      margPartyCode: 'sup-77',
    });
    expect(dup.body.error.field).toBe('margPartyCode');
    const otherState = await addSeller(execP.token, { gstin: await randomGstin('27') });
    expect(otherState.body.error.field).toBe('gstin');
  });

  it('an executive assigns only to himself; a Sales Leader adding a seller gets him himself', async () => {
    const other = await addSeller(execP.token, {
      gstin: await randomGstin(),
      assignedToEmployeeId: leaderQ.employeeId,
    });
    expect(other.body.error.field).toBe('assignedToEmployeeId');

    const bySalesLeader = await addSeller(salesLeader.token, { gstin: await randomGstin() });
    expect(bySalesLeader.status).toBe(201);
    const seller = await sellerOf(bySalesLeader.body.data.registrationId);
    expect(await ownerOf(seller._id)).toBe(salesLeader.employeeId);
  });
});

describe('Seller approval — Purchase Leader of the team or the Queue, or Admin', () => {
  it('his own leader approves; another team’s leader and an executive cannot; Assigned to is required', async () => {
    const res = await addSeller(execP.token, { gstin: await randomGstin() });
    const id = res.body.data.registrationId as string;

    expect(
      (await approve(execP.token, id, { assignedToEmployeeId: execP.employeeId })).status,
    ).toBe(403);
    expect(
      (await approve(leaderQ.token, id, { assignedToEmployeeId: leaderQ.employeeId })).status,
    ).toBe(403);
    const noAssignee = await approve(leaderP.token, id, {});
    expect(noAssignee.status).toBe(400);
    const ok = await approve(leaderP.token, id, { assignedToEmployeeId: execP.employeeId });
    expect(ok.status).toBe(200);
    expect(await ownerOf((await sellerOf(id))._id)).toBe(execP.employeeId);
  });

  it('a Queue seller from the app needs a location at approval, and Admin can approve anyone', async () => {
    const app_ = await request(app)
      .post('/api/v1/registrations/seller')
      .send({
        mobile: randomMobile(),
        firm: 'App Seller',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'MP/IND/INS/2016/0771',
        references: [
          { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Good' },
          { firm: 'Ref Two', phone: '9000000002', relationship: 'Supplier', whatTheySaid: 'Good' },
        ],
        bankDetail: { accountNumber: '000900012345678', ifsc: 'HDFC0001234', accountName: 'Owner' },
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      });
    const id = app_.body.data.registrationId as string;
    const noPlace = await approve(leaderQ.token, id, { assignedToEmployeeId: leaderQ.employeeId });
    expect(noPlace.body.error.field).toBe('location.tehsilId');
    const ok = await approve(admin.token, id, {
      assignedToEmployeeId: leaderQ.employeeId,
      location: home,
    });
    expect(ok.status).toBe(200);
  });

  it('the Registrations list shows Assigned to and District on seller rows', async () => {
    await addSeller(execP.token, { gstin: await randomGstin(), firm: 'Listed Seller' });
    const list = await request(app)
      .get('/api/v1/staff/registrations?stage=pending&limit=100')
      .set('Authorization', `Bearer ${leaderP.token}`);
    const row = (
      list.body.data as Array<{ firm: string; assignedTo: string; district: string }>
    ).find((r) => r.firm === 'Listed Seller');
    expect(row).toMatchObject({ assignedTo: 'Purchase Exec P', district: 'Test District' });
  });
});

describe('Seller profile Edit', () => {
  let sellerId: string;
  beforeAll(async () => {
    const res = await addSeller(execP.token, { gstin: await randomGstin(), firm: 'Edit Seller' });
    sellerId = String((await sellerOf(res.body.data.registrationId))._id);
  });
  const profile = async (token: string) =>
    (
      await request(app)
        .get(`/api/v1/staff/sellers/${sellerId}/profile`)
        .set('Authorization', `Bearer ${token}`)
    ).body.data;
  const edit = (token: string, base: Record<string, unknown>, changes: Record<string, unknown>) =>
    request(app)
      .put(`/api/v1/staff/sellers/${sellerId}/profile`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key())
      .send({
        firm: base.firm,
        ownerName: base.ownerName,
        contactMobile: base.contactMobile,
        gstin: base.gstin,
        licenceNo: base.licenceNo,
        location: home,
        ...changes,
      });

  it('his executive and his leader edit; another team cannot; only Admin changes the GSTIN', async () => {
    const base = await profile(execP.token);
    expect(base).toMatchObject({
      canEdit: true,
      canEditIdentity: false,
      assignedTo: { person: 'Purchase Exec P' },
      assignedLeader: { person: 'Purchase Leader P' },
    });
    expect((await edit(execP.token, base, { firm: 'Edited Seller' })).status).toBe(200);
    expect((await edit(leaderP.token, base, { firm: 'Edited Again' })).status).toBe(200);
    expect((await edit(leaderQ.token, base, { firm: 'Not Mine' })).status).toBe(403);
    const newGstin = await randomGstin();
    const byLeader = await edit(leaderP.token, base, { firm: 'Edited Again', gstin: newGstin });
    expect(byLeader.status).toBe(403);
    expect(byLeader.body.error.field).toBe('gstin');
    const byAdmin = await edit(admin.token, base, { firm: 'Edited Again', gstin: newGstin });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.data.pan).toBe(newGstin.slice(2, 12));
  });
});

describe('Purchase "Assigned to" picker and switch-off hand-over', () => {
  it('an executive gets himself; his leader the team — never a Sales Leader, who reports to Admin (DEC-066)', async () => {
    const names = async (token: string) =>
      (
        (
          await request(app)
            .get('/api/v1/staff/purchase/assignees')
            .set('Authorization', `Bearer ${token}`)
        ).body.data as Array<{ person: string }>
      )
        .map((p) => p.person)
        .sort();
    expect(await names(execP.token)).toEqual(['Purchase Exec P']);
    expect(await names(leaderP.token)).toEqual(['Purchase Exec P', 'Purchase Leader P']);
  });

  it('switching an executive off hands his sellers to the picked person', async () => {
    const holder = await Employee.findById(admin.employeeId);
    if ((await LaneAllocation.countDocuments()) === 0) {
      const lanes = await Lane.find();
      await LaneAllocation.create(lanes.map((l) => ({ laneKey: l.key, employeeId: holder!._id })));
    }
    const exec = await person('Leaving Exec', ['purchase'], ['PURCHASE_EXEC'], {
      purchase: leaderP.employeeId,
    });
    const res = await addSeller(exec.token, { gstin: await randomGstin() });
    const seller = await sellerOf(res.body.data.registrationId);
    const impact = await request(app)
      .get(`/api/v1/admin/employees/${exec.employeeId}/deactivation-impact`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(impact.body.data).toMatchObject({ sellersOwned: 1, needsReassign: true });
    const off = await request(app)
      .post(`/api/v1/admin/employees/${exec.employeeId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key())
      .send({ reassignToEmployeeId: leaderP.employeeId });
    expect(off.status).toBe(200);
    expect(await ownerOf(seller._id)).toBe(leaderP.employeeId);
  });
});
