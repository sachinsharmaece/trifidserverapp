import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Lane } from '../src/models/Lane.js';
import { LaneAllocation } from '../src/models/LaneAllocation.js';
import { createAbsence, listLaneBoard } from '../src/modules/admin/admin.service.js';
import { randomEmail } from './helpers.js';

async function makeEmployee(): Promise<InstanceType<typeof Employee>> {
  const role = await Role.findOne({ key: 'purchase' });
  return Employee.create({
    person: `Test ${Math.random()}`,
    email: randomEmail(),
    passwordHash: 'not-a-real-hash',
    roleIds: [role!._id],
    mfaEnabled: false,
    active: true,
  });
}

const actor = {
  employeeId: new mongoose.Types.ObjectId().toString(),
  correlationId: 'test-correlation',
};

describe('Absence cover chain (BR-264)', () => {
  it('resolves a two-deep chain to the final active coverer, not an empty chair', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    const c = await makeEmployee();

    const now = new Date();
    const farFuture = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const nearPast = new Date(now.getTime() - 1000);

    // A is away, covered by B.
    await createAbsence(
      {
        employeeId: (a._id as unknown as string).toString(),
        from: nearPast,
        returnDate: farFuture,
        coveredBy: (b._id as unknown as string).toString(),
      },
      actor,
    );
    // B is then also away, covered by C.
    await createAbsence(
      {
        employeeId: (b._id as unknown as string).toString(),
        from: nearPast,
        returnDate: farFuture,
        coveredBy: (c._id as unknown as string).toString(),
      },
      actor,
    );

    // Give A a lane to hold so the board shows the resolution.
    const lane = await Lane.findOne();
    await LaneAllocation.deleteMany({ laneKey: lane!.key });
    await LaneAllocation.create({ laneKey: lane!.key, employeeId: a._id });

    const board = await listLaneBoard();
    const row = board.find((item) => item.laneKey === lane!.key);
    expect(row?.holderEmployeeId).toBe((a._id as unknown as string).toString());
    expect(row?.effectiveHolderEmployeeId).toBe((c._id as unknown as string).toString());
  });

  it('refuses to mark the last active person absent', async () => {
    // Deactivate every employee except one, then try to mark that one away.
    await Employee.updateMany({}, { $set: { active: false } });
    const onlyActive = await makeEmployee();
    const coverer = await makeEmployee();
    await Employee.updateOne({ _id: coverer._id }, { $set: { active: false } });

    await expect(
      createAbsence(
        {
          employeeId: (onlyActive._id as unknown as string).toString(),
          from: new Date(),
          returnDate: new Date(Date.now() + 86400000),
          coveredBy: (coverer._id as unknown as string).toString(),
        },
        actor,
      ),
    ).rejects.toThrow(/last active person/);
  });

  it('rejects a cover chain that would loop back on itself', async () => {
    // Reactivate everyone left inactive by the previous test so the
    // last-active-person guard does not interfere with this one.
    await Employee.updateMany({}, { $set: { active: true } });
    const x = await makeEmployee();
    const y = await makeEmployee();

    const now = new Date();
    const farFuture = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // X is covered by Y.
    await createAbsence(
      {
        employeeId: (x._id as unknown as string).toString(),
        from: now,
        returnDate: farFuture,
        coveredBy: (y._id as unknown as string).toString(),
      },
      actor,
    );

    // Now try to make Y covered by X — a direct cycle.
    await expect(
      createAbsence(
        {
          employeeId: (y._id as unknown as string).toString(),
          from: now,
          returnDate: farFuture,
          coveredBy: (x._id as unknown as string).toString(),
        },
        actor,
      ),
    ).rejects.toThrow(/loop/);
  });
});
