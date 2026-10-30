import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { State } from '../src/models/State.js';
import { District } from '../src/models/District.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Pincode } from '../src/models/Pincode.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { STATE_SEED } from '../src/config/states.js';
import { recordPincodeIfUnknown } from '../src/modules/territory/territory.masters.js';
import {
  BACKUP_COLLECTION,
  migrateLocationMasters,
  rollbackLocationMigration,
} from '../src/modules/territory/territory.migration.js';
import { staffToken } from './m4helpers.js';

const app = createApp();
let admin: { token: string; employeeId: string };
let sales: { token: string; employeeId: string };
let purchase: { token: string; employeeId: string };
let mpId: string;

let keyCounter = 0;
const key = () => `loc-${Date.now()}-${(keyCounter += 1)}`;

function post(path: string, token: string, body: unknown) {
  return request(app)
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send(body as object);
}

function patch(path: string, token: string, body: unknown) {
  return request(app)
    .patch(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send(body as object);
}

function get(path: string, token: string) {
  return request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  sales = await staffToken(app, 'sales');
  purchase = await staffToken(app, 'purchase');
  mpId = String((await State.findOne({ gstStateCode: '23' }))!._id);
});

describe('State master (Phase 1, check 1)', () => {
  it('is seeded from the client list, Madhya Pradesh once, with its GST code', async () => {
    const res = await get('/admin/states', sales.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(STATE_SEED.length);
    const mp = (res.body.data as { name: string; gstStateCode: string }[]).filter((s) =>
      /madhya/i.test(s.name),
    );
    expect(mp).toEqual([expect.objectContaining({ name: 'Madhya Pradesh', gstStateCode: '23' })]);
  });

  it('refuses a second state with the same name or code, naming the field', async () => {
    const byName = await post('/admin/states', admin.token, {
      name: 'maharashtra',
      gstStateCode: '98',
    });
    expect(byName.status).toBe(400);
    expect(byName.body.error.field).toBe('name');
    const byCode = await post('/admin/states', admin.token, {
      name: 'Nowhere',
      gstStateCode: '27',
    });
    expect(byCode.body.error.field).toBe('gstStateCode');
    expect(byCode.body.error.message_en).toMatch(/Maharashtra/);
  });
});

describe('Adding masters — Admin yes, executives no (check 2)', () => {
  it('Admin adds a district and a tehsil under it; names are tidied; each is audited', async () => {
    const district = await post('/admin/districts', admin.token, {
      name: '  khandwa ',
      stateId: mpId,
    });
    expect(district.status).toBe(201);
    expect(district.body.data.name).toBe('Khandwa');

    const tehsil = await post('/admin/tehsils', admin.token, {
      name: 'pandhana',
      districtId: district.body.data.districtId,
    });
    expect(tehsil.status).toBe(201);
    const saved = await Tehsil.findById(tehsil.body.data.tehsilId);
    expect(saved).toMatchObject({ name: 'Pandhana', district: 'Khandwa', state: 'Madhya Pradesh' });
    expect(String(saved!.districtId)).toBe(district.body.data.districtId);

    const audits = await AuditLog.find({
      entity: { $in: ['district', 'tehsil'] },
      field: 'create',
    });
    expect(audits.map((a) => a.entity).sort()).toEqual(['district', 'tehsil']);
  });

  it('refuses a duplicate district or tehsil whatever the case', async () => {
    const dup = await post('/admin/districts', admin.token, { name: 'KHANDWA', stateId: mpId });
    expect(dup.status).toBe(400);
    expect(dup.body.error.field).toBe('name');
    const khandwa = await District.findOne({ name: 'Khandwa' });
    const dupTehsil = await post('/admin/tehsils', admin.token, {
      name: 'PANDHANA',
      districtId: String(khandwa!._id),
    });
    expect(dupTehsil.status).toBe(400);
    expect(dupTehsil.body.error.message_en).toMatch(/already exists in Khandwa/);
  });

  it('Sales and Purchase executives can read the masters but not add to them', async () => {
    expect((await get('/admin/tehsils', sales.token)).status).toBe(200);
    expect((await get(`/admin/districts?stateId=${mpId}`, purchase.token)).status).toBe(200);
    for (const who of [sales, purchase]) {
      const res = await post('/admin/districts', who.token, { name: 'Harda', stateId: mpId });
      expect(res.status).toBe(403);
      const tehsil = await post('/admin/tehsils', who.token, {
        name: 'Anywhere',
        districtId: String((await District.findOne({ name: 'Khandwa' }))!._id),
      });
      expect(tehsil.status).toBe(403);
    }
  });

  it('every master write needs an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/v1/admin/districts')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Harda', stateId: mpId });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('Idempotency-Key');
  });

  it('edits a tehsil’s name and district, carrying the new names onto the record', async () => {
    const dewas = await post('/admin/districts', admin.token, { name: 'Dewas', stateId: mpId });
    const tehsil = await Tehsil.findOne({ name: 'Pandhana' });
    const res = await patch(`/admin/tehsils/${String(tehsil!._id)}`, admin.token, {
      name: 'Pandhana Kalan',
      districtId: dewas.body.data.districtId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Pandhana Kalan',
      district: 'Dewas',
      stateId: mpId,
    });
    const audit = await AuditLog.findOne({ entity: 'tehsil', field: 'edit' });
    expect(audit?.oldValue).toMatchObject({ name: 'Pandhana' });
    expect(
      (await patch(`/admin/tehsils/${String(tehsil!._id)}`, sales.token, { name: 'X Y' })).status,
    ).toBe(403);
  });
});

describe('Pincodes (check 3)', () => {
  let tehsilId: string;
  let otherTehsilId: string;

  beforeAll(async () => {
    const district = await District.create({ name: 'Ujjain', stateId: mpId });
    tehsilId = String(
      (
        await Tehsil.create({
          name: 'Mahidpur',
          district: 'Ujjain',
          state: 'Madhya Pradesh',
          districtId: district._id,
        })
      )._id,
    );
    otherTehsilId = String(
      (
        await Tehsil.create({
          name: 'Tarana',
          district: 'Ujjain',
          state: 'Madhya Pradesh',
          districtId: district._id,
        })
      )._id,
    );
  });

  it('an unknown pincode looks up as null, then saves as unverified against the picked tehsil', async () => {
    const before = await get('/admin/pincodes/456443', sales.token);
    expect(before.status).toBe(200);
    expect(before.body.data).toBeNull();

    const saved = await recordPincodeIfUnknown(
      { pincode: '456443', tehsilId },
      { employeeId: sales.employeeId, correlationId: 'test' },
    );
    expect(saved.status).toBe('created');

    const after = await get('/admin/pincodes/456443', sales.token);
    expect(after.body.data).toMatchObject({
      status: 'unverified',
      tehsilName: 'Mahidpur',
      districtName: 'Ujjain',
      stateName: 'Madhya Pradesh',
      stateId: mpId,
    });

    const list = await get('/admin/pincodes?status=unverified', admin.token);
    expect(list.body.data).toEqual([
      expect.objectContaining({ pincode: '456443', createdByName: 'Test sales' }),
    ]);
  });

  it('a different tehsil picked on a later form never changes a known pincode', async () => {
    const again = await recordPincodeIfUnknown(
      { pincode: '456443', tehsilId: otherTehsilId },
      { employeeId: sales.employeeId, correlationId: 'test' },
    );
    expect(again.status).toBe('known');
    expect(String((await Pincode.findOne({ pincode: '456443' }))!.tehsilId)).toBe(tehsilId);
  });

  it('only Admin corrects the tehsil and verifies it', async () => {
    const denied = await patch('/admin/pincodes/456443', sales.token, { verify: true });
    expect(denied.status).toBe(403);
    const res = await patch('/admin/pincodes/456443', admin.token, {
      tehsilId: otherTehsilId,
      verify: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'verified', tehsilName: 'Tarana' });
    const row = await Pincode.findOne({ pincode: '456443' });
    expect(String(row!.verifiedBy)).toBe(admin.employeeId);
    expect(await AuditLog.countDocuments({ entity: 'pincode', field: 'verify' })).toBe(1);
  });

  it('refuses a malformed pincode in plain language', async () => {
    const res = await get('/admin/pincodes/045200', sales.token);
    expect(res.status).toBe(400);
    expect(res.body.error.message_en).toMatch(/6-digit pincode/);
  });
});

describe('Migration: free-text tehsils onto the masters (check 1, suspected duplicates)', () => {
  it('dry run writes nothing; apply links; a second apply changes nothing; rollback restores', async () => {
    await Tehsil.deleteMany({});
    await District.deleteMany({});
    await mongoose.connection.collection(BACKUP_COLLECTION).deleteMany({});
    await Tehsil.create([
      { name: 'Ujjain', district: 'ujjain', state: 'MP' },
      { name: 'Mahidpur', district: 'Ujjain ', state: 'mp' },
      { name: 'Mehidpur', district: 'UJJAIN', state: 'Madhya Pradesh' },
      { name: 'Patera,damoh', district: 'Damoh', state: 'M.P.' },
      { name: 'Tarana', district: 'Ujjain', state: 'Madhya Pradesh' },
      { name: 'Tarana', district: 'ujjain', state: 'MP' }, // same place twice
      { name: 'Somewhere', district: 'Nowhere', state: 'Atlantis' },
      { name: 'barnagar', district: 'ujjain', state: 'MP' },
      { name: 'MP Nagar', district: 'Bhopal', state: 'MP' },
    ]);

    const dry = await migrateLocationMasters({ apply: false });
    expect(dry.mode).toBe('dry-run');
    expect(await District.countDocuments()).toBe(0);
    expect(await Tehsil.countDocuments({ districtId: { $ne: null } })).toBe(0);
    expect(dry.districtsCreated.sort()).toEqual([
      'Bhopal, Madhya Pradesh',
      'Damoh, Madhya Pradesh',
      'Ujjain, Madhya Pradesh',
    ]);
    expect(dry.linked).toHaveLength(7);

    const applied = await migrateLocationMasters({ apply: true });
    expect(applied.linked).toHaveLength(7);
    expect(await District.countDocuments()).toBe(3);
    // An all-lowercase name is capitalised; a name with capitals is left as typed.
    expect(await Tehsil.exists({ name: 'Barnagar', district: 'Ujjain' })).not.toBeNull();
    expect(await Tehsil.exists({ name: 'MP Nagar', district: 'Bhopal' })).not.toBeNull();
    expect(await Tehsil.countDocuments({ state: { $in: ['MP', 'mp', 'M.P.'] } })).toBe(1); // the conflicting Tarana, left as it was
    const ujjainTehsils = await Tehsil.find({ district: 'Ujjain', districtId: { $ne: null } });
    expect(ujjainTehsils.map((t) => t.name).sort()).toEqual([
      'Barnagar',
      'Mahidpur',
      'Mehidpur',
      'Tarana',
      'Ujjain',
    ]);

    expect(applied.unknownState).toEqual([
      { tehsil: 'Somewhere', district: 'Nowhere', state: 'Atlantis' },
    ]);
    expect(applied.conflicts).toHaveLength(1);
    expect(applied.conflicts[0]!.tehsil).toMatch(/^Tarana \(ujjain, MP\)/);
    const dupNames = applied.suspectedDuplicates.map((d) => d.names.join('/'));
    expect(dupNames).toContain('Mahidpur/Mehidpur');
    expect(dupNames).toContain('Patera,damoh');

    const again = await migrateLocationMasters({ apply: true });
    expect(again.linked).toHaveLength(0);
    expect(again.districtsCreated).toHaveLength(0);
    expect(again.alreadyLinked).toBe(7);

    const { restored } = await rollbackLocationMigration();
    expect(restored).toBe(7);
    expect(await Tehsil.exists({ name: 'barnagar' })).not.toBeNull();
    expect(await Tehsil.countDocuments({ districtId: { $ne: null } })).toBe(0);
    expect(await Tehsil.findOne({ name: 'Mahidpur' })).toMatchObject({
      district: 'Ujjain ',
      state: 'mp',
    });
  });
});
