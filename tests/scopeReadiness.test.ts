import { describe, expect, it } from 'vitest';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { scopeReadiness } from '../src/shared/scopeReadiness.js';
import { randomEmail, randomMobile } from './helpers.js';

/** Phase 7 — the check run before OWNERSHIP_SCOPE_ENFORCED is switched on. */
async function employee(person: string, roleKeys: string[], extra: Record<string, unknown> = {}) {
  const roles = await Role.find({ key: { $in: roleKeys } });
  return Employee.create({
    person,
    email: randomEmail(),
    mobile: randomMobile(),
    passwordHash: 'x',
    roleIds: roles.map((r) => r._id),
    active: true,
    ...extra,
  });
}

describe('Phase 7 — scope readiness', () => {
  it('names who would be left seeing only his own leads, and is ready once they are set', async () => {
    const leader = await employee('Ready Leader', ['sales', 'purchase'], {
      positions: ['SALES_LEADER', 'PURCHASE_EXEC'],
    });
    leader.reportsToSalesLeaderId = leader._id as never;
    await leader.save();
    const bare = await employee('Bare Sales', ['sales']);
    const orphan = await employee('Orphan Exec', ['sales'], { positions: ['SALES_EXEC'] });
    const accounts = await employee('Teamless Accounts', ['accounts']);

    const before = await scopeReadiness();
    expect(before.ready).toBe(false);
    expect(before.noPosition).toContain('Bare Sales');
    expect(before.noLeader).toEqual(expect.arrayContaining(['Orphan Exec (Sales)']));
    // DEC-066 — a Sales Leader reports to Admin on the Purchase side.
    expect(before.noLeader).not.toContain('Ready Leader (Purchase)');
    expect(before.noTeams).toContain('Teamless Accounts');

    bare.positions = ['SALES_EXEC'] as never;
    bare.reportsToSalesLeaderId = leader._id as never;
    await bare.save();
    orphan.reportsToSalesLeaderId = leader._id as never;
    await orphan.save();
    leader.reportsToPurchaseLeaderId = leader._id as never;
    await leader.save();
    accounts.worksForAllTeams = true;
    await accounts.save();
    // Anyone else this file's database holds is not ours to judge — look only at our people.
    const after = await scopeReadiness();
    for (const name of ['Bare Sales', 'Orphan Exec', 'Ready Leader', 'Teamless Accounts']) {
      expect(JSON.stringify([after.noPosition, after.noLeader, after.noTeams])).not.toContain(name);
    }
  });
});
