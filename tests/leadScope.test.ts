import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { PERMISSIONS } from '../src/config/permissions.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { SellerAssignment } from '../src/models/SellerAssignment.js';
import { Absence } from '../src/models/Absence.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { bumpCounter } from '../src/middleware/rateLimit.js';
import { visibilityFor } from '../src/shared/scope.js';
import { loginStaff, mfaSecretFor, randomEmail, randomGstin, randomMobile } from './helpers.js';

/**
 * Phase 5 (DEC-060) — who sees which buyer and seller, with
 * OWNERSHIP_SCOPE_ENFORCED on: an executive his own; a leader his team and
 * the Queue; a coverer what the absent person sees; Accounts the teams he
 * works for; Admin and Founder everything. Plus the two ways past the wall —
 * the exact lookup and Change owner.
 */
const app = createApp();
const PASSWORD = 'CorrectHorse123';
let keyCounter = 0;
const key = () => `scope-${Date.now()}-${(keyCounter += 1)}`;

interface Staff {
  token: string;
  employeeId: string;
}

async function person(
  name: string,
  roleKeys: string[],
  positions: string[],
  extra: {
    reportsToSales?: string | 'self';
    reportsToPurchase?: string | 'self';
    worksFor?: string[];
  } = {},
): Promise<Staff> {
  const roles = await Role.find({ key: { $in: roleKeys } });
  const email = randomEmail();
  const mfaSecret = mfaSecretFor(roleKeys);
  const e = await Employee.create({
    person: name,
    mfaSecret,
    mfaEnabled: Boolean(mfaSecret),
    email,
    mobile: randomMobile(),
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    roleIds: roles.map((r) => r._id),
    positions,
    worksForTeamLeaderIds: extra.worksFor ?? [],
    active: true,
  });
  if (extra.reportsToSales) {
    e.reportsToSalesLeaderId = (
      extra.reportsToSales === 'self' ? e._id : extra.reportsToSales
    ) as never;
  }
  if (extra.reportsToPurchase) {
    e.reportsToPurchaseLeaderId = (
      extra.reportsToPurchase === 'self' ? e._id : extra.reportsToPurchase
    ) as never;
  }
  await e.save();
  return { token: await loginStaff(app, email, PASSWORD, mfaSecret), employeeId: String(e._id) };
}

interface Lead {
  profileId: string;
  counterpartyId: string;
  gstin: string;
  firm: string;
}

async function buyer(firm: string, ownerEmployeeId: string | null): Promise<Lead> {
  const gstin = await randomGstin();
  const cp = await Counterparty.create({
    mobile: randomMobile(),
    kind: 'buyer',
    status: 'active',
    firm,
    gstin,
  });
  const b = await Buyer.create({ counterpartyId: cp._id });
  if (ownerEmployeeId) {
    await BookAssignment.create({
      buyerId: b._id,
      ownerEmployeeId,
      assignedAt: new Date(),
      assignedBy: ownerEmployeeId,
      reason: 'test',
    });
  }
  return { profileId: String(b._id), counterpartyId: String(cp._id), gstin, firm };
}

async function seller(firm: string, ownerEmployeeId: string | null): Promise<Lead> {
  const gstin = await randomGstin();
  const cp = await Counterparty.create({
    mobile: randomMobile(),
    kind: 'seller',
    status: 'active',
    firm,
    gstin,
  });
  const s = await Seller.create({ counterpartyId: cp._id });
  if (ownerEmployeeId) {
    await SellerAssignment.create({
      sellerId: s._id,
      ownerEmployeeId,
      assignedAt: new Date(),
      assignedBy: ownerEmployeeId,
      reason: 'test',
    });
  }
  return { profileId: String(s._id), counterpartyId: String(cp._id), gstin, firm };
}

const get = (path: string, who: Staff) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, who: Staff, body: object) =>
  request(app)
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${who.token}`)
    .set('Idempotency-Key', key())
    .send(body);
const buyerIds = async (who: Staff): Promise<string[]> => {
  const res = await get('/staff/sales/buyers', who);
  expect(res.status).toBe(200);
  return (res.body.data as Array<{ buyerId: string }>).map((r) => r.buyerId);
};

let leaderL: Staff; // Sales Leader, team L
let execA: Staff; // in team L
let execB: Staff; // in team L
let leaderM: Staff; // Sales Leader, team M
let execC: Staff; // in team M
let accountsL: Staff; // works for team L
let admin: Staff;
let purchaseLeaderP: Staff;
let purchaseExecP: Staff;
let purchaseLeaderQ: Staff;
let ofA: Lead;
let ofB: Lead;
let ofC: Lead;
let queued: Lead;
let sellerOfP: Lead;

beforeAll(async () => {
  env.ownershipScopeEnforced = true;
  leaderL = await person('Leela Leader', ['sales'], ['SALES_LEADER', 'PURCHASE_EXEC'], {
    reportsToSales: 'self',
  });
  execA = await person('Arun Exec', ['sales'], ['SALES_EXEC'], {
    reportsToSales: leaderL.employeeId,
  });
  execB = await person('Bina Exec', ['sales'], ['SALES_EXEC'], {
    reportsToSales: leaderL.employeeId,
  });
  leaderM = await person('Mohan Leader', ['sales'], ['SALES_LEADER', 'PURCHASE_EXEC'], {
    reportsToSales: 'self',
  });
  execC = await person('Chetan Exec', ['sales'], ['SALES_EXEC'], {
    reportsToSales: leaderM.employeeId,
  });
  accountsL = await person('Asha Accounts', ['accounts'], [], { worksFor: [leaderL.employeeId] });
  admin = await person('Adi Admin', ['admin'], []);
  purchaseLeaderP = await person('Prem Purchase', ['purchase'], ['PURCHASE_LEADER'], {
    reportsToPurchase: 'self',
  });
  purchaseExecP = await person('Pooja Purchase', ['purchase'], ['PURCHASE_EXEC'], {
    reportsToPurchase: purchaseLeaderP.employeeId,
  });
  purchaseLeaderQ = await person('Qadir Purchase', ['purchase'], ['PURCHASE_LEADER'], {
    reportsToPurchase: 'self',
  });

  ofA = await buyer('Arun Medicals', execA.employeeId);
  ofB = await buyer('Bina Pharma', execB.employeeId);
  ofC = await buyer('Chetan Drug House', execC.employeeId);
  queued = await buyer('Queue Chemists', null);
  sellerOfP = await seller('Pooja Distributors', purchaseExecP.employeeId);
}, 120000);

afterAll(() => {
  env.ownershipScopeEnforced = false;
});

describe('Phase 5 — who sees which buyer', () => {
  it('an executive sees only his own buyers — not his teammate’s, another team’s, or the Queue', async () => {
    const ids = await buyerIds(execA);
    expect(ids).toContain(ofA.profileId);
    expect(ids).not.toContain(ofB.profileId);
    expect(ids).not.toContain(ofC.profileId);
    expect(ids).not.toContain(queued.profileId);
  });

  it('opening a buyer outside his scope answers OUT_OF_SCOPE with the firm and the leader only', async () => {
    const res = await get(`/staff/sales/buyers/${ofC.profileId}`, execA);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OUT_OF_SCOPE');
    expect(res.body.error.meta).toEqual({ firm: 'Chetan Drug House', leader: 'Mohan Leader' });

    const queue = await get(`/staff/sales/buyers/${queued.profileId}`, execA);
    expect(queue.status).toBe(403);
    expect(queue.body.error.message_en).toMatch(/Queue/);
  });

  it('a leader sees his whole team and the Queue, not another team', async () => {
    const ids = await buyerIds(leaderL);
    expect(ids).toEqual(expect.arrayContaining([ofA.profileId, ofB.profileId, queued.profileId]));
    expect(ids).not.toContain(ofC.profileId);
  });

  it('Admin sees everything; Founder and Controller hold LEADS_SEE_ALL', async () => {
    const ids = await buyerIds(admin);
    expect(ids).toEqual(
      expect.arrayContaining([ofA.profileId, ofB.profileId, ofC.profileId, queued.profileId]),
    );
    for (const roleKey of ['founder', 'controller']) {
      const role = await Role.findOne({ key: roleKey });
      expect(role!.permissionKeys).toContain(PERMISSIONS.LEADS_SEE_ALL);
    }
    const seesAll = await visibilityFor('sales', {
      employeeId: execA.employeeId,
      permissions: [PERMISSIONS.LEADS_SEE_ALL],
    });
    expect(seesAll.all).toBe(true);
  });

  it('while an executive is away, whoever covers him sees his buyers too — and stops when he is back', async () => {
    const absence = await Absence.create({
      employeeId: execB.employeeId,
      from: new Date(Date.now() - 60_000),
      returnDate: new Date(Date.now() + 60 * 60_000),
      coveredBy: execA.employeeId,
      reason: 'Leave',
      createdBy: leaderL.employeeId,
    });
    expect(await buyerIds(execA)).toContain(ofB.profileId);
    await Absence.deleteOne({ _id: absence._id });
    expect(await buyerIds(execA)).not.toContain(ofB.profileId);
  });

  it('Accounts sees the teams he works for, not the others', async () => {
    const mine = await get(`/staff/buyers/${ofA.profileId}/ledger`, accountsL);
    expect(mine.status).not.toBe(403);
    const other = await get(`/staff/buyers/${ofC.profileId}/ledger`, accountsL);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('OUT_OF_SCOPE');
  });

  it('with the flag off, everyone sees everything, as before Phase 5', async () => {
    env.ownershipScopeEnforced = false;
    try {
      const ids = await buyerIds(execA);
      expect(ids).toEqual(expect.arrayContaining([ofB.profileId, ofC.profileId, queued.profileId]));
    } finally {
      env.ownershipScopeEnforced = true;
    }
  });
});

describe('Phase 5 — who sees which seller', () => {
  it('a Purchase executive sees his own sellers; another Purchase team is refused', async () => {
    expect(
      (await get(`/staff/purchase/sellers/${sellerOfP.profileId}/dealerships`, purchaseExecP))
        .status,
    ).toBe(200);
    expect(
      (await get(`/staff/purchase/sellers/${sellerOfP.profileId}/dealerships`, purchaseLeaderP))
        .status,
    ).toBe(200);
    const res = await get(
      `/staff/purchase/sellers/${sellerOfP.profileId}/dealerships`,
      purchaseLeaderQ,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.meta).toEqual({ firm: 'Pooja Distributors', leader: 'Prem Purchase' });
  });
});

describe('Phase 5 — exact lookup', () => {
  it('answers firm, side and leader for a lead owned elsewhere, and opens only what is in scope', async () => {
    const res = await get(`/staff/lookup?gstin=${ofC.gstin}`, execA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        firm: 'Chetan Drug House',
        side: 'buyer',
        leader: 'Mohan Leader',
        inQueue: false,
        profileId: null,
      },
    ]);
    const own = await get(`/staff/lookup?gstin=${ofA.gstin}`, execA);
    expect(own.body.data[0].profileId).toBe(ofA.profileId);
    expect(
      await AuditLog.countDocuments({ entity: 'lead_lookup', entityId: execA.employeeId }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('finds by mobile, and by contact mobile', async () => {
    const cp = await Counterparty.findById(ofC.counterpartyId);
    const contact = randomMobile();
    cp!.contactMobile = contact;
    await cp!.save();
    for (const mobile of [cp!.mobile!, contact]) {
      const res = await get(`/staff/lookup?mobile=${mobile}`, execA);
      expect(res.body.data.map((m: { firm: string }) => m.firm)).toEqual(['Chetan Drug House']);
    }
  });

  it('takes exactly one of GSTIN, PAN or mobile, in full', async () => {
    expect((await get(`/staff/lookup?gstin=${ofC.gstin}&pan=ABCDE1234F`, execA)).status).toBe(400);
    expect((await get('/staff/lookup?gstin=23ABC', execA)).status).toBe(400);
    expect((await get('/staff/lookup', execA)).status).toBe(400);
  });

  it('is rate-limited per employee', async () => {
    for (let i = 0; i < 60; i += 1) await bumpCounter(`lead-lookup:${execB.employeeId}`, 3600);
    const res = await get(`/staff/lookup?gstin=${ofA.gstin}`, execB);
    expect(res.status).toBe(429);
  });
});

describe('Phase 5 — Change owner', () => {
  it('a leader moves a buyer within his team; the new owner sees him, the old one no longer does', async () => {
    const moved = await buyer('Moved Medicals', execA.employeeId);
    const res = await post(`/staff/buyers/${moved.profileId}/owner`, leaderL, {
      ownerEmployeeId: execB.employeeId,
      note: 'Bina covers that market now',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ownerEmployeeId: execB.employeeId, owner: 'Bina Exec' });
    expect(await buyerIds(execB)).toContain(moved.profileId);
    expect(await buyerIds(execA)).not.toContain(moved.profileId);
    const audit = await AuditLog.findOne({
      entity: 'book_assignment',
      'newValue.buyerId': moved.profileId,
    });
    expect(audit!.oldValue).toEqual({ ownerEmployeeId: execA.employeeId });
    expect(audit!.reason).toBe('Bina covers that market now');
  });

  it('the profile says who may change owner: his leader and Admin, not the executive', async () => {
    const can = async (who: Staff) => {
      const res = await get(`/staff/buyers/${ofA.profileId}/profile`, who);
      expect(res.status).toBe(200);
      return res.body.data.canChangeOwner as boolean;
    };
    expect(await can(leaderL)).toBe(true);
    expect(await can(admin)).toBe(true);
    expect(await can(execA)).toBe(false);
  });

  it('back to the Queue with null', async () => {
    const moved = await buyer('Requeued Medicals', execA.employeeId);
    const res = await post(`/staff/buyers/${moved.profileId}/owner`, leaderL, {
      ownerEmployeeId: null,
    });
    expect(res.status).toBe(200);
    expect(await BookAssignment.countDocuments({ buyerId: moved.profileId })).toBe(0);
  });

  it('an executive cannot change owner; another team’s leader cannot reach in; nobody hands outside his team', async () => {
    const exec = await post(`/staff/buyers/${ofA.profileId}/owner`, execA, {
      ownerEmployeeId: execB.employeeId,
    });
    expect(exec.status).toBe(403);
    expect(exec.body.error.code).toBe('PERMISSION_DENIED');

    const other = await post(`/staff/buyers/${ofA.profileId}/owner`, leaderM, {
      ownerEmployeeId: execC.employeeId,
    });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('OUT_OF_SCOPE');

    const outside = await post(`/staff/buyers/${ofA.profileId}/owner`, leaderL, {
      ownerEmployeeId: execC.employeeId,
    });
    expect(outside.status).toBe(400);
    expect(outside.body.error.field).toBe('ownerEmployeeId');
  });

  it('Admin moves anyone, across teams', async () => {
    const moved = await buyer('Crossed Medicals', execA.employeeId);
    const res = await post(`/staff/buyers/${moved.profileId}/owner`, admin, {
      ownerEmployeeId: execC.employeeId,
    });
    expect(res.status).toBe(200);
  });

  it('needs an Idempotency-Key', async () => {
    const res = await request(app)
      .post(`/api/v1/staff/buyers/${ofA.profileId}/owner`)
      .set('Authorization', `Bearer ${leaderL.token}`)
      .send({ ownerEmployeeId: execA.employeeId });
    expect(res.status).toBe(400);
  });

  it('a Purchase leader moves his team’s seller; another Purchase leader cannot', async () => {
    const other = await post(`/staff/sellers/${sellerOfP.profileId}/owner`, purchaseLeaderQ, {
      ownerEmployeeId: purchaseLeaderQ.employeeId,
    });
    expect(other.status).toBe(403);
    const res = await post(`/staff/sellers/${sellerOfP.profileId}/owner`, purchaseLeaderP, {
      ownerEmployeeId: purchaseLeaderP.employeeId,
    });
    expect(res.status).toBe(200);
    const assignment = await SellerAssignment.findOne({ sellerId: sellerOfP.profileId });
    expect(String(assignment!.ownerEmployeeId as Types.ObjectId)).toBe(purchaseLeaderP.employeeId);
  });

  it('"Add to my book" follows the same rule: an unowned buyer may be taken, an owned one may not', async () => {
    const free = await buyer('Free Medicals', null);
    const take = await request(app)
      .post('/api/v1/admin/book-assignments')
      .set('Authorization', `Bearer ${execA.token}`)
      .send({ buyerId: free.profileId, ownerEmployeeId: execA.employeeId });
    expect(take.status).toBe(201);

    const steal = await request(app)
      .post('/api/v1/admin/book-assignments')
      .set('Authorization', `Bearer ${execA.token}`)
      .send({ buyerId: ofB.profileId, ownerEmployeeId: execA.employeeId });
    expect(steal.status).toBe(403);
    expect(steal.body.error.code).toBe('OUT_OF_SCOPE');
  });
});
