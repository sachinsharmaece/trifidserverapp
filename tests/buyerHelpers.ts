import request from 'supertest';
import type { Express } from 'express';
import bcrypt from 'bcryptjs';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { State } from '../src/models/State.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { ensureDistrict } from '../src/modules/territory/territory.masters.js';
import { loginStaff, randomEmail, randomMobile } from './helpers.js';

/**
 * Phase 3 — approving a buyer needs a Sales Leader (BUYER_APPROVE comes with
 * the position) and a location whose State → District → Tehsil hang
 * together. Most tests make a bare tehsil with no district; `locationFor`
 * links it to a test district first, so every existing tehsil fixture still
 * works.
 */
export interface TestLocation {
  address: string;
  stateId: string;
  districtId: string;
  tehsilId: string;
}

export async function locationFor(tehsilId: string): Promise<TestLocation> {
  const mp = await State.findOne({ gstStateCode: '23' });
  const tehsil = await Tehsil.findById(tehsilId);
  if (!tehsil) throw new Error(`No tehsil ${tehsilId}`);
  let districtId = tehsil.districtId ? String(tehsil.districtId) : null;
  if (!districtId) {
    const district = await ensureDistrict(mp!._id, 'Test District');
    districtId = district.districtId;
    // As the masters do (BR-348): the tehsil's text names follow its district.
    tehsil.districtId = district.districtId as never;
    tehsil.district = district.name;
    tehsil.state = mp!.name;
    await tehsil.save();
  }
  return { address: '1 Test Road, Indore', stateId: String(mp!._id), districtId, tehsilId };
}

let approver: Promise<{ token: string; employeeId: string }> | null = null;

/** One Sales Leader per test file (the database is emptied before each file). */
export function salesLeader(app: Express): Promise<{ token: string; employeeId: string }> {
  approver ??= (async () => {
    const roles = await Role.find({ key: { $in: ['sales', 'purchase'] } });
    const password = 'CorrectHorse123';
    const email = randomEmail();
    const leader = await Employee.create({
      person: 'Test Sales Leader',
      email,
      mobile: randomMobile(),
      passwordHash: await bcrypt.hash(password, 10),
      roleIds: roles.map((r) => r._id),
      positions: ['SALES_LEADER', 'SALES_EXEC', 'PURCHASE_EXEC'],
      active: true,
    });
    leader.reportsToSalesLeaderId = leader._id as never;
    await leader.save();
    return { token: await loginStaff(app, email, password), employeeId: String(leader._id) };
  })();
  return approver;
}

export type Category = 'Retailer' | 'Dealer' | 'Distributor' | 'Trader';

export function categoryFromPosition(
  tradePosition: 'distributor' | 'dealer' | 'retailer',
): Category {
  return (tradePosition.charAt(0).toUpperCase() + tradePosition.slice(1)) as Category;
}

/** Approves a pending buyer registration as the file's Sales Leader, assigned to him. */
export async function approveBuyerRegistration(
  app: Express,
  registrationId: string,
  opts: { tehsilId: string; category?: Category },
): Promise<request.Response> {
  const leader = await salesLeader(app);
  return request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${leader.token}`)
    .set('Idempotency-Key', `approve-${registrationId}-${Date.now()}-${Math.random()}`)
    .send({
      category: opts.category ?? 'Dealer',
      location: await locationFor(opts.tehsilId),
      assignedToEmployeeId: leader.employeeId,
    });
}
