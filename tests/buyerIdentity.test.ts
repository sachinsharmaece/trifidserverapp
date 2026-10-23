import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Pincode } from '../src/models/Pincode.js';
import { toRateTier } from '../src/modules/chain/chain.service.js';
import { lookupGstin } from '../src/modules/exclusion/exclusion.service.js';
import {
  migrateBuyerIdentity,
  BUYER_BACKUP_COLLECTION,
} from '../src/modules/onboarding/buyer.migration.js';
import { computeGstinChecksum } from '../src/shared/validators.js';
import mongoose from 'mongoose';
import { loginStaff, randomEmail, randomGstin, randomMobile } from './helpers.js';
import { locationFor, type TestLocation } from './buyerHelpers.js';
import { staffToken } from './m4helpers.js';

const app = createApp();
const PASSWORD = 'CorrectHorse123';
let keyCounter = 0;
const key = () => `buyer-${Date.now()}-${(keyCounter += 1)}`;

interface Staff {
  token: string;
  employeeId: string;
}

/** A Sales person with positions, signed in. */
async function salesPerson(
  person: string,
  positions: string[],
  reportsToSalesLeaderId: string | 'self' | null = null,
): Promise<Staff> {
  const roles = await Role.find({ key: { $in: ['sales', 'purchase'] } });
  const email = randomEmail();
  const employee = await Employee.create({
    person,
    email,
    mobile: randomMobile(),
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    roleIds: roles.map((r) => r._id),
    positions,
    active: true,
  });
  employee.reportsToSalesLeaderId = (
    reportsToSalesLeaderId === 'self' ? employee._id : reportsToSalesLeaderId
  ) as never;
  await employee.save();
  return { token: await loginStaff(app, email, PASSWORD), employeeId: String(employee._id) };
}

function gstinWithPan(pan: string, state = '23'): string {
  const first14 = `${state}${pan}1Z`;
  return `${first14}${computeGstinChecksum(first14)}`;
}

let leaderA: Staff;
let execA: Staff;
let leaderB: Staff;
let admin: Staff;
let location: TestLocation;

function register(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/staff/registrations/buyer')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({
      mobile: randomMobile(),
      firm: `Firm ${Math.random()}`,
      category: 'Retailer',
      location,
      consent: { noticeVersion: 'v1', marketingOptIn: false },
      proprietorAgreed: true,
      ...body,
    });
}

beforeAll(async () => {
  leaderA = await salesPerson('Leader A', ['SALES_LEADER', 'SALES_EXEC', 'PURCHASE_EXEC'], 'self');
  execA = await salesPerson('Exec A', ['SALES_EXEC'], leaderA.employeeId);
  leaderB = await salesPerson('Leader B', ['SALES_LEADER', 'SALES_EXEC', 'PURCHASE_EXEC'], 'self');
  admin = await staffToken(app, 'admin');
  const tehsil = await Tehsil.create({
    name: `Mahidpur ${Date.now()}`,
    district: 'D',
    state: 'MP',
  });
  location = await locationFor(String(tehsil._id));
});

describe('GSTIN or PAN (check 11)', () => {
  it('saves with GSTIN only — PAN is taken from it — and with PAN only, as unregistered', async () => {
    const gstin = await randomGstin();
    const withGstin = await register(execA.token, { gstin });
    expect(withGstin.status).toBe(201);
    const cp = await Counterparty.findById(withGstin.body.data.registrationId);
    expect(cp!.pan).toBe(gstin.slice(2, 12));

    const panOnly = await register(execA.token, { pan: 'abcfp1234k' });
    expect(panOnly.status).toBe(201);
    const cp2 = await Counterparty.findById(panOnly.body.data.registrationId);
    expect(cp2!.gstin).toBeUndefined();
    expect(cp2!.pan).toBe('ABCFP1234K');
  });

  it('refuses when both are empty, with one clear message', async () => {
    const res = await register(execA.token, { gstin: '', pan: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toEqual([
      { field: 'gstin', message: 'Enter the GSTIN — or the PAN, if he has no GSTIN.' },
    ]);
  });

  it('refuses a bad GSTIN checksum, a bad PAN, a PAN not matching the GSTIN, and a GSTIN from another state', async () => {
    const good = await randomGstin();
    const badChecksum = `${good.slice(0, 14)}${good[14] === 'A' ? 'B' : 'A'}`;
    expect((await register(execA.token, { gstin: badChecksum })).body.error.field).toBe('gstin');
    expect((await register(execA.token, { pan: 'ABC1234567' })).body.error.field).toBe('pan');
    const mismatch = await register(execA.token, { gstin: good, pan: 'ZZZPZ9999Z' });
    expect(mismatch.body.error.field).toBe('pan');
    const maharashtra = await register(execA.token, { gstin: await randomGstin('27') });
    expect(maharashtra.status).toBe(400);
    expect(maharashtra.body.error.field).toBe('gstin');
    expect(maharashtra.body.error.message_en).toMatch(/state code 27.*Madhya Pradesh \(23\)/);
  });

  it('a missing category or tehsil is a field error', async () => {
    const noCategory = await register(execA.token, {
      gstin: await randomGstin(),
      category: undefined,
    });
    expect(noCategory.body.error.fieldErrors).toEqual(
      expect.arrayContaining([{ field: 'category', message: 'Pick the category.' }]),
    );
    const noTehsil = await register(execA.token, {
      gstin: await randomGstin(),
      location: { ...location, tehsilId: '' },
    });
    expect(noTehsil.body.error.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'location.tehsilId', message: 'Pick the tehsil from the list.' },
      ]),
    );
  });

  it('the buyer app takes PAN only too, and refuses when both are empty', async () => {
    const base = {
      mobile: randomMobile(),
      firm: 'App Firm',
      ownerName: 'Owner',
      licenceNo: 'LIC-777',
      gstPpobAddress: 'Somewhere',
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    };
    const panOnly = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({ ...base, pan: 'APPFP1234Q' });
    expect(panOnly.status).toBe(201);
    const none = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({ ...base, mobile: randomMobile() });
    expect(none.body.error.field).toBe('gstin');
  });
});

describe('Duplicates and warnings (check 12)', () => {
  it('a GSTIN already on a buyer is refused, naming the firm', async () => {
    const gstin = await randomGstin();
    await register(execA.token, { gstin, firm: 'First Traders' });
    const again = await register(execA.token, { gstin });
    expect(again.status).toBe(400);
    expect(again.body.error.field).toBe('gstin');
    expect(again.body.error.meta.existingFirm).toBe('First Traders');
  });

  it('a PAN already on a buyer without GSTIN is refused', async () => {
    await register(execA.token, { pan: 'DUPFP1234D', firm: 'Pan Firm' });
    const again = await register(execA.token, { pan: 'DUPFP1234D' });
    expect(again.body.error.field).toBe('pan');
    expect(again.body.error.meta.existingFirm).toBe('Pan Firm');
  });

  it('a PAN inside another buyer’s GSTIN needs a confirm tick', async () => {
    await register(execA.token, { gstin: gstinWithPan('INSFP1234I'), firm: 'Gstin Holder' });
    const warned = await register(execA.token, { pan: 'INSFP1234I' });
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(warned.body.error.meta.warnings).toEqual([
      expect.objectContaining({ key: 'panInsideGstin', existingFirm: 'Gstin Holder' }),
    ]);
    const confirmed = await register(execA.token, {
      pan: 'INSFP1234I',
      confirmations: { panInsideGstin: true },
    });
    expect(confirmed.status).toBe(201);
  });

  it('a shared mobile needs a confirm tick, and the second firm gets no login of its own', async () => {
    const mobile = randomMobile();
    await register(execA.token, { gstin: await randomGstin(), mobile, firm: 'Mobile Owner' });
    const warned = await register(execA.token, { gstin: await randomGstin(), mobile });
    expect(warned.status).toBe(409);
    expect(warned.body.error.meta.warnings[0]).toMatchObject({
      key: 'sharedMobile',
      existingFirm: 'Mobile Owner',
    });
    const confirmed = await register(execA.token, {
      gstin: await randomGstin(),
      mobile,
      confirmations: { sharedMobile: true },
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.loginMobile).toBe(false);
    const cp = await Counterparty.findById(confirmed.body.data.registrationId);
    expect(cp!.mobile).toBeNull();
    expect(cp!.contactMobile).toBe(mobile);
  });

  it('a Marg party code is unique among buyers', async () => {
    await register(execA.token, { gstin: await randomGstin(), margPartyCode: 'mg-001' });
    const again = await register(execA.token, {
      gstin: await randomGstin(),
      margPartyCode: 'MG-001',
    });
    expect(again.body.error.field).toBe('margPartyCode');
  });
});

describe('Assigned to, no OTP, approval (checks 14, 15)', () => {
  it('defaults to the executive who registered him; an executive cannot assign to someone else', async () => {
    const res = await register(execA.token, { gstin: await randomGstin() });
    const buyer = await Buyer.findOne({ counterpartyId: res.body.data.registrationId });
    expect(String((await BookAssignment.findOne({ buyerId: buyer!._id }))!.ownerEmployeeId)).toBe(
      execA.employeeId,
    );
    const other = await register(execA.token, {
      gstin: await randomGstin(),
      assignedToEmployeeId: leaderB.employeeId,
    });
    expect(other.body.error.field).toBe('assignedToEmployeeId');
  });

  it('no OTP: the registration is approvable at once, the audit names the staff member, and an unknown pincode is saved unverified', async () => {
    const res = await register(execA.token, {
      gstin: await randomGstin(),
      location: { ...location, pincode: '456443' },
      callNote: 'Rang in.',
    });
    expect(res.status).toBe(201);
    const audit = await AuditLog.findOne({
      entityId: res.body.data.registrationId,
      field: 'staff_assisted_registration',
    });
    expect(String(audit!.actorId)).toBe(execA.employeeId);
    expect(audit!.actorType).toBe('staff');
    expect((await Pincode.findOne({ pincode: '456443' }))!.status).toBe('unverified');

    const profile = await request(app)
      .get(`/api/v1/staff/registrations/${res.body.data.registrationId}/buyer-profile`)
      .set('Authorization', `Bearer ${leaderA.token}`);
    expect(profile.body.data).toMatchObject({
      category: 'Retailer',
      location: { tehsilId: location.tehsilId, pincode: '456443' },
      assignedTo: { employeeId: execA.employeeId, person: 'Exec A' },
      assignedLeader: { employeeId: leaderA.employeeId },
    });
  });

  it('only his team’s leader or Admin approves; the old "Is trader" body is refused; category and Assigned to are set', async () => {
    const res = await register(execA.token, { gstin: await randomGstin() });
    const registrationId = res.body.data.registrationId as string;
    const approve = (token: string, body: Record<string, unknown>) =>
      request(app)
        .post(`/api/v1/staff/registrations/${registrationId}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key())
        .send(body);
    const body = { category: 'Trader', location, assignedToEmployeeId: execA.employeeId };

    expect((await approve(execA.token, body)).status).toBe(403); // an executive
    expect((await approve(leaderB.token, body)).status).toBe(403); // another team's leader
    const legacy = await approve(leaderA.token, {
      tehsilId: location.tehsilId,
      tradePosition: 'dealer',
      isTrader: true,
    });
    expect(legacy.status).toBe(400);
    const ok = await approve(leaderA.token, body);
    expect(ok.status).toBe(200);
    const buyer = await Buyer.findOne({ counterpartyId: registrationId });
    expect(buyer!.category).toBe('Trader');
    expect(toRateTier(buyer!)).toBe('Trader');
  });

  it('Admin approves any buyer', async () => {
    const res = await register(execA.token, { gstin: await randomGstin() });
    const ok = await request(app)
      .post(`/api/v1/staff/registrations/${res.body.data.registrationId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', key())
      .send({ category: 'Dealer', location, assignedToEmployeeId: leaderB.employeeId });
    expect(ok.status).toBe(200);
  });

  it('the Registrations list shows each desk its own side, with Assigned to and District', async () => {
    const purchase = await staffToken(app, 'purchase');
    const mine = await register(execA.token, { gstin: await randomGstin() });
    expect(mine.status).toBe(201);
    await request(app)
      .post('/api/v1/registrations/buyer')
      .send({
        mobile: randomMobile(),
        firm: 'From The App',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'LIC-778',
        gstPpobAddress: 'Somewhere',
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      });
    const salesList = await request(app)
      .get('/api/v1/staff/registrations?stage=pending&limit=100')
      .set('Authorization', `Bearer ${execA.token}`);
    expect(salesList.body.data.every((r: { kind: string }) => r.kind !== 'seller')).toBe(true);
    expect(
      salesList.body.data.find((r: { assignedTo: string | null }) => r.assignedTo === 'Exec A'),
    ).toMatchObject({ assignedTo: 'Exec A', district: 'Test District' });
    // A buyer from the app sits in the Queue until a leader assigns him.
    expect(
      salesList.body.data.some((r: { assignedTo: string | null }) => r.assignedTo === null),
    ).toBe(true);
    const purchaseList = await request(app)
      .get('/api/v1/staff/registrations?stage=pending&limit=100')
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(purchaseList.body.data.every((r: { kind: string }) => r.kind !== 'buyer')).toBe(true);
  });
});

describe('Category is the margin column (check 16)', () => {
  it('reads the category first, the old fields only as a fallback', () => {
    expect(toRateTier({ category: 'Distributor', isTrader: true, tradePosition: 'retailer' })).toBe(
      'Distributor',
    );
    expect(toRateTier({ category: null, isTrader: true, tradePosition: 'dealer' })).toBe('Trader');
    expect(toRateTier({ category: null, isTrader: false, tradePosition: null })).toBe('Retailer');
  });

  it('the migration gives existing buyers a category without moving their column, and is idempotent', async () => {
    const make = async (legacy: Record<string, unknown>) => {
      const cp = await Counterparty.create({
        mobile: randomMobile(),
        kind: 'buyer',
        status: 'active',
        gstin: await randomGstin(),
      });
      return Buyer.collection.insertOne({
        counterpartyId: cp._id,
        isTrader: false,
        rateViews: 0,
        classified: true,
        openingBalancePaise: 0,
        category: null,
        address: null,
        gstPpobAddress: 'Old Road',
        ...legacy,
      });
    };
    const trader = await make({ isTrader: true, tradePosition: 'dealer' });
    const dealer = await make({ tradePosition: 'dealer' });
    const never = await make({ tradePosition: null, classified: false });

    const dry = await migrateBuyerIdentity({ apply: false });
    expect(dry.categorySet).toMatchObject({ Trader: 1, Dealer: 1 });
    expect((await Buyer.findById(trader.insertedId))!.category).toBeNull();

    const applied = await migrateBuyerIdentity({ apply: true });
    expect(applied.marginColumnMismatches).toEqual([]);
    expect((await Buyer.findById(trader.insertedId))!.category).toBe('Trader');
    expect((await Buyer.findById(dealer.insertedId))!.category).toBe('Dealer');
    expect((await Buyer.findById(never.insertedId))!.category).toBeNull();
    expect((await Buyer.findById(dealer.insertedId))!.address).toBe('Old Road');

    const again = await migrateBuyerIdentity({ apply: true });
    expect(again.categorySet).toEqual({});
    expect(again.panFilled).toBe(0);
    expect(
      await mongoose.connection.collection(BUYER_BACKUP_COLLECTION).countDocuments(),
    ).toBeGreaterThan(0);
  });
});

describe('Buyer profile Edit (check 17)', () => {
  let buyerId: string;
  beforeAll(async () => {
    const res = await register(execA.token, { gstin: await randomGstin(), firm: 'Edit Me' });
    buyerId = String((await Buyer.findOne({ counterpartyId: res.body.data.registrationId }))!._id);
  });

  async function current(token: string) {
    return (
      await request(app)
        .get(`/api/v1/staff/buyers/${buyerId}/profile`)
        .set('Authorization', `Bearer ${token}`)
    ).body.data;
  }
  function edit(token: string, changes: Record<string, unknown>, base: Record<string, unknown>) {
    return request(app)
      .put(`/api/v1/staff/buyers/${buyerId}/profile`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key())
      .send({
        firm: base.firm,
        contactMobile: base.contactMobile,
        gstin: base.gstin ?? '',
        pan: base.pan ?? '',
        category: base.category,
        location: { ...location },
        ...changes,
      });
  }

  it('his executive edits details, not the category; his leader changes the category; only Admin changes GSTIN', async () => {
    const base = await current(execA.token);
    expect(base).toMatchObject({ canEdit: true, canEditCategory: false, canEditIdentity: false });

    const renamed = await edit(execA.token, { firm: 'Edited Traders' }, base);
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.firm).toBe('Edited Traders');

    const category = await edit(execA.token, { firm: 'Edited Traders', category: 'Dealer' }, base);
    expect(category.status).toBe(403);
    expect(category.body.error.field).toBe('category');
    const byLeader = await edit(
      leaderA.token,
      { firm: 'Edited Traders', category: 'Dealer' },
      base,
    );
    expect(byLeader.status).toBe(200);

    const newGstin = await randomGstin();
    const byLeaderGstin = await edit(
      leaderA.token,
      { firm: 'Edited Traders', category: 'Dealer', gstin: newGstin, pan: '' },
      base,
    );
    expect(byLeaderGstin.status).toBe(403);
    const byAdmin = await edit(
      admin.token,
      { firm: 'Edited Traders', category: 'Dealer', gstin: newGstin, pan: '' },
      base,
    );
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.data.pan).toBe(newGstin.slice(2, 12));
    expect(
      await AuditLog.countDocuments({ entityId: buyerId, entity: 'buyer', field: 'edit' }),
    ).toBe(3);
  });

  it('someone outside his team cannot edit him', async () => {
    const base = await current(admin.token);
    const res = await edit(leaderB.token, { firm: 'Not Mine' }, base);
    expect(res.status).toBe(403);
  });
});

describe('Exclusion by PAN (DEC-054)', () => {
  it('a seller can find a buyer without a GSTIN by his PAN', async () => {
    await register(execA.token, { pan: 'EXCFP1234E', firm: 'Excluded Pan Traders' });
    const sellerCp = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'seller',
      status: 'active',
    });
    const found = await lookupGstin('EXCFP1234E', String(sellerCp._id), '127.0.0.1');
    expect(found).toEqual({ exists: true, maskedFirm: expect.stringMatching(/^E\*+ P\*+ T\*+$/) });
  });
});

describe('The "Assigned to" picker', () => {
  const names = async (token: string) =>
    (
      (
        await request(app)
          .get('/api/v1/staff/sales/assignees')
          .set('Authorization', `Bearer ${token}`)
      ).body.data as Array<{ person: string }>
    )
      .map((p) => p.person)
      .sort();

  it('an executive gets himself, a leader his team, Admin every Sales person', async () => {
    expect(await names(execA.token)).toEqual(['Exec A']);
    expect(await names(leaderA.token)).toEqual(['Exec A', 'Leader A']);
    expect(await names(admin.token)).toEqual(
      expect.arrayContaining(['Exec A', 'Leader A', 'Leader B']),
    );
  });

  it('Sales can read the company list for "Companies he deals in"', async () => {
    const res = await request(app)
      .get('/api/v1/staff/purchase/masters/manufacturers')
      .set('Authorization', `Bearer ${execA.token}`);
    expect(res.status).toBe(200);
  });
});
