import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { SellerAssignment } from '../src/models/SellerAssignment.js';
import { SellerPush } from '../src/models/SellerPush.js';
import { StaffNotice } from '../src/models/StaffNotice.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { loginStaff, randomEmail, randomGstin, randomMobile } from './helpers.js';
import { locationFor, type TestLocation } from './buyerHelpers.js';
import { staffToken } from './m4helpers.js';

/**
 * Phase 6 — Push to Purchase (checks 19, 20, 21): routing to the team's
 * Sales Leader, identity-only copy, the wall, the GSTIN gate for a PAN-only
 * buyer, the notices, and one buyer + one seller per firm, linked.
 */
const app = createApp();
const PASSWORD = 'CorrectHorse123';
let keyCounter = 0;
const key = () => `push-${Date.now()}-${(keyCounter += 1)}`;

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
  if (reportsTo.sales) {
    e.reportsToSalesLeaderId = (reportsTo.sales === 'self' ? e._id : reportsTo.sales) as never;
  }
  if (reportsTo.purchase) {
    e.reportsToPurchaseLeaderId = (
      reportsTo.purchase === 'self' ? e._id : reportsTo.purchase
    ) as never;
  }
  await e.save();
  return { token: await loginStaff(app, email, PASSWORD), employeeId: String(e._id) };
}

const get = (path: string, who: Staff) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, who: Staff, body: object) =>
  request(app)
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${who.token}`)
    .set('Idempotency-Key', key())
    .send(body);

let purchaseLeaderP: Staff;
let purchaseLeaderQ: Staff;
let leaderL: Staff; // Sales Leader of team L, its Purchase Exec, reports (purchase) to P
let execA: Staff; // Sales Exec in team L
let execB: Staff; // Sales Exec in team L
let purchaseExecQ: Staff; // in Q's team
let admin: Staff;
let home: TestLocation;
let areaId: string;

interface TestBuyer {
  buyerId: string;
  counterpartyId: string;
  gstin: string | null;
  pan: string;
  firm: string;
}

async function activeBuyer(
  firm: string,
  owner: string | null,
  identity: { panOnly?: boolean } = {},
): Promise<TestBuyer> {
  const gstin = await randomGstin();
  const pan = gstin.slice(2, 12);
  const cp = await Counterparty.create({
    mobile: randomMobile(),
    contactMobile: randomMobile(),
    kind: 'buyer',
    status: 'active',
    firm,
    ownerName: `${firm} Owner`,
    licenceNo: 'MP/IND/INS/2016/0771',
    ...(identity.panOnly ? { pan } : { gstin, pan }),
  });
  const b = await Buyer.create({
    counterpartyId: cp._id,
    tehsilId: home.tehsilId,
    address: home.address,
    pincode: '452001',
    margPartyCode: `BUY${Math.floor(Math.random() * 1e6)}`,
  });
  if (owner) {
    await BookAssignment.create({
      buyerId: b._id,
      ownerEmployeeId: owner,
      assignedAt: new Date(),
      assignedBy: owner,
    });
  }
  return {
    buyerId: String(b._id),
    counterpartyId: String(cp._id),
    gstin: identity.panOnly ? null : gstin,
    pan,
    firm,
  };
}

const completion = (extra: Record<string, unknown> = {}) => ({
  licenceNo: 'MP/IND/INS/2016/0771',
  location: home,
  references: [
    { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Good' },
    { firm: 'Ref Two', phone: '9000000002', relationship: 'Supplier', whatTheySaid: 'Good' },
  ],
  bankDetail: { accountNumber: '000900012345678', ifsc: 'HDFC0001234', accountName: 'Owner' },
  callNote: 'First call done — he carries two companies.',
  ...extra,
});

const approval = (assignedToEmployeeId: string) => ({
  tehsilIds: [areaId],
  dispatchCutoffTime: '16:00',
  assignedToEmployeeId,
});

beforeAll(async () => {
  purchaseLeaderP = await person(
    'Prem Purchase',
    ['purchase'],
    ['PURCHASE_LEADER', 'PURCHASE_EXEC'],
    {
      purchase: 'self',
    },
  );
  purchaseLeaderQ = await person(
    'Qadir Purchase',
    ['purchase'],
    ['PURCHASE_LEADER', 'PURCHASE_EXEC'],
    {
      purchase: 'self',
    },
  );
  purchaseExecQ = await person('Quila Purchase', ['purchase'], ['PURCHASE_EXEC'], {
    purchase: purchaseLeaderQ.employeeId,
  });
  leaderL = await person(
    'Leela Leader',
    ['sales', 'purchase'],
    ['SALES_LEADER', 'SALES_EXEC', 'PURCHASE_EXEC'],
    {
      sales: 'self',
      purchase: purchaseLeaderP.employeeId,
    },
  );
  execA = await person('Arun Exec', ['sales'], ['SALES_EXEC'], { sales: leaderL.employeeId });
  execB = await person('Bina Exec', ['sales'], ['SALES_EXEC'], { sales: leaderL.employeeId });
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
}, 120000);

describe('Phase 6 — the button and the routing (check 19)', () => {
  it('goes to the Sales Leader of the buyer’s team, and only his executive, leader or Admin may push', async () => {
    const buyer = await activeBuyer('Arun Agro', execA.employeeId);
    const status = await get(`/staff/buyers/${buyer.buyerId}/push`, execA);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      canPush: true,
      blockedReason: null,
      receiver: { employeeId: leaderL.employeeId, person: 'Leela Leader' },
      canChooseReceiver: false,
    });
    const teammate = await get(`/staff/buyers/${buyer.buyerId}/push`, execB);
    expect(teammate.body.data.canPush).toBe(false);

    const res = await post(`/staff/buyers/${buyer.buyerId}/push`, execA, {
      note: 'He also stocks two companies',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.receiver.person).toBe('Leela Leader');

    const again = await get(`/staff/buyers/${buyer.buyerId}/push`, execA);
    expect(again.body.data).toMatchObject({ canPush: false, openPush: { status: 'pending' } });
    expect(again.body.data.blockedReason).toMatch(/already pending/);
    const twice = await post(`/staff/buyers/${buyer.buyerId}/push`, execA, { note: 'Again' });
    expect(twice.status).toBe(400);

    const received = await StaffNotice.findOne({
      employeeId: leaderL.employeeId,
      kind: 'push_received',
    });
    expect(received!.title).toMatch(/Arun Agro/);
  });

  it('a buyer in the Queue goes to the pusher’s own leader; only Admin picks someone else', async () => {
    const queued = await activeBuyer('Queue Agro', null);
    const notMine = await post(`/staff/buyers/${queued.buyerId}/push`, leaderL, {
      note: 'Supplies seed',
      receiverEmployeeId: purchaseExecQ.employeeId,
    });
    expect(notMine.status).toBe(400);
    expect(notMine.body.error.field).toBe('receiverEmployeeId');

    const res = await post(`/staff/buyers/${queued.buyerId}/push`, leaderL, {
      note: 'Supplies seed',
    });
    expect(res.body.data.receiver.employeeId).toBe(leaderL.employeeId);

    const other = await activeBuyer('Admin Routed Agro', execA.employeeId);
    const routed = await post(`/staff/buyers/${other.buyerId}/push`, admin, {
      note: 'Send to Q',
      receiverEmployeeId: purchaseExecQ.employeeId,
    });
    expect(routed.status).toBe(201);
    expect(routed.body.data.receiver.person).toBe('Quila Purchase');
  });

  it('needs an Idempotency-Key, and a note', async () => {
    const buyer = await activeBuyer('Keyless Agro', execA.employeeId);
    const noKey = await request(app)
      .post(`/api/v1/staff/buyers/${buyer.buyerId}/push`)
      .set('Authorization', `Bearer ${execA.token}`)
      .send({ note: 'x x x' });
    expect(noKey.status).toBe(400);
    const noNote = await post(`/staff/buyers/${buyer.buyerId}/push`, execA, { note: '' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.field).toBe('note');
  });
});

describe('Phase 6 — Purchase side and the wall (checks 19, 20)', () => {
  it('Purchase sees identity, "Pushed by" and the note only — no Marg code, orders or rates', async () => {
    const buyer = await activeBuyer('Wall Agro', execA.employeeId);
    const pushed = await post(`/staff/buyers/${buyer.buyerId}/push`, execA, {
      note: 'Has stock of X',
    });
    const pushId = pushed.body.data.pushId as string;

    const list = await get('/staff/purchase/pushes', leaderL);
    const row = (list.body.data as Array<{ pushId: string }>).find((r) => r.pushId === pushId);
    expect(row).toMatchObject({
      firm: 'Wall Agro',
      pushedBy: 'Arun Exec',
      note: 'Has stock of X',
      status: 'pending',
    });
    // Another Purchase team does not see it.
    const q = await get('/staff/purchase/pushes', purchaseLeaderQ);
    expect((q.body.data as Array<{ pushId: string }>).some((r) => r.pushId === pushId)).toBe(false);
    expect((await get(`/staff/purchase/pushes/${pushId}`, purchaseLeaderQ)).status).toBe(403);

    const detail = await get(`/staff/purchase/pushes/${pushId}`, leaderL);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      firm: 'Wall Agro',
      gstin: buyer.gstin,
      pan: buyer.pan,
      ownerName: 'Wall Agro Owner',
      licenceNo: 'MP/IND/INS/2016/0771',
      pushedBy: 'Arun Exec',
      note: 'Has stock of X',
      needsGstin: false,
      canComplete: true,
      canDecide: false,
    });
    expect(detail.body.data.location.tehsilId).toBe(home.tehsilId);
    const text = JSON.stringify(detail.body.data);
    expect(text).not.toMatch(/margPartyCode"\s*:\s*"BUY/);
    expect(text).not.toMatch(/order|rate|ask|callLog|category/i);
  });

  it('PAN-only: completes without a GSTIN, but cannot be approved until one is added (check 19)', async () => {
    const buyer = await activeBuyer('Pan Only Agro', execA.employeeId, { panOnly: true });
    const pushId = (await post(`/staff/buyers/${buyer.buyerId}/push`, execA, { note: 'Seeds' }))
      .body.data.pushId as string;
    expect((await get(`/staff/purchase/pushes/${pushId}`, leaderL)).body.data.needsGstin).toBe(
      true,
    );

    expect(
      (await post(`/staff/purchase/pushes/${pushId}/complete`, leaderL, completion())).status,
    ).toBe(200);
    const blocked = await post(
      `/staff/purchase/pushes/${pushId}/approve`,
      admin,
      approval(leaderL.employeeId),
    );
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.field).toBe('gstin');

    // A GSTIN that is not his PAN's is refused.
    const wrong = await post(
      `/staff/purchase/pushes/${pushId}/complete`,
      leaderL,
      completion({ gstin: await randomGstin() }),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.field).toBe('gstin');

    const { computeGstinChecksum } = await import('../src/shared/validators.js');
    const first14 = `23${buyer.pan}1Z`;
    const gstin = `${first14}${computeGstinChecksum(first14)}`;
    expect(
      (await post(`/staff/purchase/pushes/${pushId}/complete`, leaderL, completion({ gstin })))
        .status,
    ).toBe(200);
    const ok = await post(
      `/staff/purchase/pushes/${pushId}/approve`,
      admin,
      approval(leaderL.employeeId),
    );
    expect(ok.status).toBe(200);
    // The GSTIN is the firm's now — the buyer side carries it too.
    expect((await Counterparty.findById(buyer.counterpartyId))!.gstin).toBe(gstin);
  });

  it('a Sales Leader’s push is decided by Admin only (DEC-066); the receiver himself cannot', async () => {
    const buyer = await activeBuyer('Decide Agro', execA.employeeId);
    const pushId = (
      await post(`/staff/buyers/${buyer.buyerId}/push`, execA, { note: 'Seeds and more' })
    ).body.data.pushId as string;
    await post(`/staff/purchase/pushes/${pushId}/complete`, leaderL, completion());
    expect(
      (
        await post(
          `/staff/purchase/pushes/${pushId}/approve`,
          leaderL,
          approval(leaderL.employeeId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          `/staff/purchase/pushes/${pushId}/approve`,
          purchaseLeaderQ,
          approval(purchaseLeaderQ.employeeId),
        )
      ).status,
    ).toBe(403);
    // DEC-066 — the receiver is a Sales Leader, who reports to Admin: not even
    // the Purchase Leader he used to report to decides, only Admin.
    expect(
      (
        await post(
          `/staff/purchase/pushes/${pushId}/approve`,
          purchaseLeaderP,
          approval(leaderL.employeeId),
        )
      ).status,
    ).toBe(403);
    const detail = await get(`/staff/purchase/pushes/${pushId}`, admin);
    expect(detail.body.data.canDecide).toBe(true);
  });

  it('a push Admin sent to a plain Purchase Executive is decided by his own Purchase Leader', async () => {
    const buyer = await activeBuyer('Q Team Agro', execA.employeeId);
    const pushId = (
      await post(`/staff/buyers/${buyer.buyerId}/push`, admin, {
        note: 'Send to Q',
        receiverEmployeeId: purchaseExecQ.employeeId,
      })
    ).body.data.pushId as string;
    await post(`/staff/purchase/pushes/${pushId}/complete`, purchaseExecQ, completion());
    const res = await post(
      `/staff/purchase/pushes/${pushId}/approve`,
      purchaseLeaderQ,
      approval(purchaseExecQ.employeeId),
    );
    expect(res.status).toBe(200);
  });
});

describe('Phase 6 — approval, notices and the link (checks 20, 21)', () => {
  it('approval adds a seller to the same firm, linked both ways, and tells the pusher and his leader', async () => {
    const buyer = await activeBuyer('Linked Agro', execA.employeeId);
    const pushId = (
      await post(`/staff/buyers/${buyer.buyerId}/push`, execA, { note: 'Pesticides' })
    ).body.data.pushId as string;
    await post(
      `/staff/purchase/pushes/${pushId}/complete`,
      leaderL,
      completion({ margPartyCode: 'sel-001' }),
    );
    const res = await post(
      `/staff/purchase/pushes/${pushId}/approve`,
      admin,
      approval(leaderL.employeeId),
    );
    expect(res.status).toBe(200);
    const seller = (await Seller.findById(res.body.data.sellerId))!;
    expect(String(seller.counterpartyId)).toBe(buyer.counterpartyId);
    expect(String(seller.pushedFromBuyerId)).toBe(buyer.buyerId);
    expect(String(seller.sourcedByEmployeeId)).toBe(execA.employeeId);
    expect(seller.margPartyCode).toBe('SEL-001'); // his own, not the buyer's Marg code
    expect((await Counterparty.findById(buyer.counterpartyId))!.kind).toBe('both');
    expect(
      String((await SellerAssignment.findOne({ sellerId: seller._id }))!.ownerEmployeeId),
    ).toBe(leaderL.employeeId);

    const told = await StaffNotice.find({ kind: 'push_approved', title: /Linked Agro/ });
    expect(told.map((n) => String(n.employeeId)).sort()).toEqual(
      [execA.employeeId, leaderL.employeeId].sort(),
    );

    const tracking = await get('/staff/sales/pushes', execA);
    const row = (tracking.body.data as Array<{ pushId: string }>).find((r) => r.pushId === pushId);
    expect(row).toMatchObject({
      firm: 'Linked Agro',
      purchaseExecutive: 'Leela Leader',
      status: 'approved',
    });
    expect(JSON.stringify(row)).not.toMatch(/rate|listing|catalogue|trustTier/i);

    // The wall holds on the two files of one firm.
    const sellerFile = await get(`/staff/purchase/sellers/${String(seller._id)}/file`, leaderL);
    expect(sellerFile.status).toBe(200);
    expect(JSON.stringify(sellerFile.body.data)).not.toContain(buyer.buyerId);
    const buyerFile = await get(`/staff/sales/buyers/${buyer.buyerId}`, execA);
    expect(buyerFile.status).toBe(200);
    expect(JSON.stringify(buyerFile.body.data)).not.toContain('SEL-001');
    expect(JSON.stringify(buyerFile.body.data)).not.toContain(String(seller._id));

    // Already a seller → the button is off, with a link.
    const status = await get(`/staff/buyers/${buyer.buyerId}/push`, execA);
    expect(status.body.data).toMatchObject({
      canPush: false,
      alreadySeller: { sellerId: String(seller._id), firm: 'Linked Agro' },
    });
    expect(await AuditLog.countDocuments({ entity: 'seller_push', entityId: pushId })).toBe(3);
  });

  it('when the pusher is the leader himself, he is told once', async () => {
    const buyer = await activeBuyer('Self Pushed Agro', leaderL.employeeId);
    const pushId = (
      await post(`/staff/buyers/${buyer.buyerId}/push`, leaderL, { note: 'Seeds and more' })
    ).body.data.pushId as string;
    await post(`/staff/purchase/pushes/${pushId}/complete`, leaderL, completion());
    await post(`/staff/purchase/pushes/${pushId}/approve`, admin, approval(leaderL.employeeId));
    expect(
      await StaffNotice.countDocuments({ kind: 'push_approved', title: /Self Pushed Agro/ }),
    ).toBe(1);
  });

  it('rejection tells the pusher and his leader, with the reason, and frees the button', async () => {
    const buyer = await activeBuyer('Rejected Agro', execB.employeeId);
    const pushId = (await post(`/staff/buyers/${buyer.buyerId}/push`, execB, { note: 'Maybe' }))
      .body.data.pushId as string;
    const res = await post(`/staff/purchase/pushes/${pushId}/reject`, admin, {
      reason: 'No licence for resale',
    });
    expect(res.status).toBe(200);
    const told = await StaffNotice.find({ kind: 'push_rejected', title: /Rejected Agro/ });
    expect(told.map((n) => String(n.employeeId)).sort()).toEqual(
      [execB.employeeId, leaderL.employeeId].sort(),
    );
    expect(told[0]!.body).toMatch(/No licence for resale/);
    expect((await get(`/staff/buyers/${buyer.buyerId}/push`, execB)).body.data.canPush).toBe(true);
    expect((await SellerPush.findById(pushId))!.status).toBe('rejected');
  });

  it('a second seller with a buyer’s GSTIN is refused, pointing to Push to Purchase (check 21)', async () => {
    const buyer = await activeBuyer('Second Seller Agro', execA.employeeId);
    const res = await post('/staff/registrations/seller', leaderL, {
      mobile: randomMobile(),
      firm: 'Second Seller Agro',
      gstin: buyer.gstin,
      ownerName: 'Owner',
      licenceNo: 'MP/IND/INS/2016/0771',
      references: completion().references,
      bankDetail: completion().bankDetail,
      consent: { noticeVersion: 'v1', marketingOptIn: false },
      callNote: 'On a call.',
      location: home,
      proprietorAgreed: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('gstin');
    expect(res.body.error.message_en).toMatch(/Push to Purchase/);
    expect(res.body.error.meta.existingBuyerId).toBe(buyer.buyerId);
  });

  it('a PAN-only buyer whose PAN sits inside a seller’s GSTIN is "Already a seller"', async () => {
    const seller = await activeBuyer('Pan Seller Agro', execA.employeeId);
    await Seller.create({ counterpartyId: seller.counterpartyId });
    const panOnly = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'buyer',
      status: 'active',
      firm: 'Pan Seller Agro (branch)',
      pan: seller.pan,
    });
    const b = await Buyer.create({ counterpartyId: panOnly._id });
    await BookAssignment.create({
      buyerId: b._id,
      ownerEmployeeId: execA.employeeId,
      assignedAt: new Date(),
      assignedBy: execA.employeeId,
    });
    const status = await get(`/staff/buyers/${String(b._id)}/push`, execA);
    expect(status.body.data).toMatchObject({
      canPush: false,
      alreadySeller: { firm: 'Pan Seller Agro' },
    });
  });
});

describe('Phase 6 — staff notices', () => {
  it('lists my own notices with the unread count, and marks them read', async () => {
    const mine = await get('/staff/notices', leaderL);
    expect(mine.status).toBe(200);
    expect(mine.body.data.unread).toBeGreaterThan(0);
    const first = mine.body.data.items[0];
    expect((await post(`/staff/notices/${first.noticeId}/read`, leaderL, {})).status).toBe(200);
    // Not someone else's.
    expect((await post(`/staff/notices/${first.noticeId}/read`, execB, {})).status).toBe(404);
    await post('/staff/notices/read-all', leaderL, {});
    expect((await get('/staff/notices', leaderL)).body.data.unread).toBe(0);
  });
});
