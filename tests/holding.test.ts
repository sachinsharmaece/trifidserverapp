import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Buyer } from '../src/models/Buyer.js';
import { CallLog } from '../src/models/CallLog.js';
import { Config } from '../src/models/Config.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Employee } from '../src/models/Employee.js';
import { Holding } from '../src/models/Holding.js';
import { MargBill } from '../src/models/MargBill.js';
import { MargBillImport } from '../src/models/MargBillImport.js';
import { PoolReview } from '../src/models/PoolReview.js';
import { Role } from '../src/models/Role.js';
import { So } from '../src/models/So.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { withTransaction } from '../src/db/transaction.js';
import { billsFor, billsForMany } from '../src/modules/holding/holding.bills.js';
import { runDormancyClocks } from '../src/modules/holding/holding.job.js';
import {
  getStatus,
  leaveInPool,
  poolList,
  setReceivingLeads,
  teamLeaderQueue,
} from '../src/modules/holding/holding.queries.js';
import {
  assignFromPool,
  assignNewParty,
  claimParty,
  logReason,
  openGoLiveHolding,
  transferHoldings,
  uncalledByHolder,
} from '../src/modules/holding/holding.service.js';
import { getSettings } from '../src/modules/holding/holding.settings.js';
import { registerBuyer } from '../src/modules/onboarding/onboarding.service.js';
import { mayChangeOwner } from '../src/shared/team.js';
import { moveLead } from '../src/modules/lead/lead.service.js';
import { isPlaceholderMobile } from '../src/shared/placeholders.js';
import { matchParty } from '../src/scripts/lock34Common.js';
import { staffToken } from './m4helpers.js';
import { loginStaff, randomEmail, randomGstin, randomMobile } from './helpers.js';

const app = createApp();
let seq = 0;
const oid = () => new Types.ObjectId();
const ist = (day: string, time = '12:00:00') => new Date(`${day}T${time}+05:30`);
const days = (from: Date, n: number) => new Date(from.getTime() + n * 24 * 60 * 60 * 1000);

const KEYS: Record<string, string> = {
  enabled: 'dormancy.enabled',
  goLiveDate: 'dormancy.goLiveDate',
  uncalledCap: 'dormancy.uncalledCap',
  unclaimedDays: 'dormancy.unclaimedDays',
  backlogPerWeek: 'dormancy.backlogPerWeek',
};

async function setPolicy(patch: Record<string, unknown>): Promise<void> {
  for (const [name, value] of Object.entries(patch)) {
    await Config.updateOne(
      { key: KEYS[name] },
      { $set: { value, updatedBy: oid() }, $setOnInsert: { version: 1 } },
      { upsert: true },
    );
  }
}

async function makeStaff(person: string, positions: string[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const sales = await Role.findOne({ key: 'sales' });
  return Employee.create({
    person,
    email: `lock34-${seq}-${Math.floor(Math.random() * 1e6)}@trifid.example`,
    passwordHash: 'x',
    roleIds: [sales!._id],
    positions,
    active: true,
    ...extra,
  });
}

const actorOf = (e: { _id: unknown }) => ({
  employeeId: String(e._id),
  permissions: [] as string[],
  correlationId: 'test',
});

async function makeParty(
  opts: {
    firm?: string;
    status?: string;
    tehsil?: { name: string; district: string; state: string };
  } = {},
): Promise<string> {
  seq += 1;
  const mobile = `98${String(seq).padStart(8, '0')}`;
  const cp = await Counterparty.create({
    mobile,
    contactMobile: mobile,
    firm: opts.firm ?? `Firm ${seq}`,
    kind: 'buyer',
    status: opts.status ?? 'active',
  });
  const tehsil = await Tehsil.create(
    opts.tehsil ?? { name: `Tehsil ${seq}`, district: 'Indore', state: 'Madhya Pradesh' },
  );
  const buyer = await Buyer.create({ counterpartyId: cp._id, tehsilId: tehsil._id });
  return String(buyer._id);
}

/** A platform order whose Marg invoice matched, dated `day`, for `rupees`. */
async function addBill(buyerId: string, day: string, rupees: number, invoice?: string) {
  seq += 1;
  const so = await So.create({
    soNo: `SO-T-${seq}`,
    chainId: oid(),
    buyerId,
    sellerId: oid(),
    tierAtOrder: 'Dealer',
    placeOfSupply: 'intra_state',
    state: 'billed_in_marg',
    payDeadline: new Date(),
    totalPaise: rupees * 100,
  });
  await MargBill.create({
    margInvoiceNo: invoice ?? `INV-${seq}`,
    soId: so._id,
    placeOfSupply: 'intra_state',
    taxSplit: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
    valuePaise: rupees * 100,
    ewayNo: 'E1',
    state: 'matched',
    keyedBy: oid(),
    keyedAt: ist(day),
  });
}

function hold(partyId: unknown, holderId: unknown, o: Record<string, unknown> = {}) {
  return Holding.create({
    partyId,
    holderId,
    kind: 'lead',
    via: 'intake',
    startedAt: new Date(),
    isOpen: true,
    ...o,
  });
}

function pastHold(
  partyId: unknown,
  holderId: unknown,
  endedAt: Date,
  o: Record<string, unknown> = {},
) {
  return hold(partyId, holderId, {
    startedAt: days(endedAt, -30),
    endedAt,
    end: 'released',
    isOpen: false,
    ...o,
  });
}

async function call(buyerId: string, employeeId: unknown, at: Date, kind = 'call') {
  await CallLog.create({
    buyerId,
    employeeId,
    at,
    kind,
    direction: kind === 'call' ? 'out' : null,
    outcome: kind === 'call' ? 'no_answer' : null,
  });
}

const uncalledOf = async (e: { _id: unknown }) =>
  (await uncalledByHolder([String(e._id)])).get(String(e._id))!.length;

beforeAll(async () => {
  await Holding.init();
  await MargBillImport.init();
});

beforeEach(async () => {
  await Promise.all(
    [
      Holding,
      PoolReview,
      BookAssignment,
      CallLog,
      MargBill,
      MargBillImport,
      So,
      Buyer,
      Counterparty,
      Tehsil,
      Employee,
    ].map((m) => m.deleteMany({})),
  );
  await Config.deleteMany({ key: /^dormancy\./ });
});

// ---------------------------------------------------------------------------

describe('LOCK-34 — switch off (the default)', () => {
  it('writes no holding and the new routes answer 403 — except the status call', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    await assignNewParty(oid(), 'app');
    expect(await Holding.countDocuments()).toBe(0);

    const token = await staffToken(app, 'sales');
    for (const path of ['/staff/sales/party-pool', '/staff/sales/holdings/mine']) {
      const res = await request(app)
        .get(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token.token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.message_en).toBe('Dormant policy is switched off.');
    }
    const claim = await request(app)
      .post(`/api/v1/staff/sales/party-pool/${oid()}/claim`)
      .set('Authorization', `Bearer ${token.token}`)
      .set('Idempotency-Key', `k-${Math.random()}`);
    expect(claim.status).toBe(403);

    const status = await request(app)
      .get('/api/v1/staff/sales/holdings/status')
      .set('Authorization', `Bearer ${token.token}`);
    expect(status.status).toBe(200);
    expect(status.body.data.enabled).toBe(false);
    expect(await getStatus(actorOf(caller))).toMatchObject({ enabled: false, isCaller: false });
  });

  it('registering a buyer writes no holding, and Change owner is unchanged', async () => {
    await makeStaff('Caller', ['SALES_EXEC']);
    await registerBuyer(
      {
        mobile: randomMobile(),
        firm: 'Quiet Traders',
        gstin: await randomGstin(),
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      },
      undefined,
      'test',
    );
    expect(await Holding.countDocuments()).toBe(0);
    const admin = { employeeId: String(oid()), permissions: ['buyer:admin'] };
    expect(await mayChangeOwner('sales', admin, null)).toBe(true);
  });

  it('the party model has no dormant / active flag', () => {
    const paths = Object.keys(Buyer.schema.paths).concat(Object.keys(Counterparty.schema.paths));
    for (const banned of ['dormant', 'isDormant', 'active', 'isActive']) {
      expect(paths).not.toContain(banned);
    }
  });
});

describe('LOCK-34 §4.5 — intake', () => {
  beforeEach(() => setPolicy({ enabled: true, goLiveDate: '2026-01-01', uncalledCap: 50 }));

  it('deals a new lead to the caller with the fewest uncalled; a tie goes to the oldest last intake', async () => {
    const a = await makeStaff('A', ['SALES_EXEC']);
    const b = await makeStaff('B', ['SALES_EXEC']);
    const c = await makeStaff('C', ['SALES_EXEC']);
    await makeStaff('Leader', ['SALES_LEADER']);
    const t0 = ist('2026-02-01');
    for (let i = 0; i < 3; i += 1) {
      await hold(oid(), a._id, { startedAt: days(t0, 10 + i) }); // A's last intake is newer
      await hold(oid(), b._id, { startedAt: days(t0, i) });
    }
    for (let i = 0; i < 10; i += 1) await hold(oid(), c._id, { startedAt: days(t0, i) });

    const party = oid();
    await assignNewParty(party, 'app');
    const got = await Holding.findOne({ partyId: party, isOpen: true });
    expect(String(got!.holderId)).toBe(String(b._id));
    expect(got).toMatchObject({ kind: 'lead', via: 'intake', source: 'app' });
    // The old book row follows the holding.
    expect(String((await BookAssignment.findOne({ buyerId: party }))!.ownerEmployeeId)).toBe(
      String(b._id),
    );
  });

  it('gives the lead to the Team Leader when everyone is at the cap — and skips a caller who is not receiving', async () => {
    await setPolicy({ uncalledCap: 2 });
    const a = await makeStaff('A', ['SALES_EXEC']);
    const away = await makeStaff('Away', ['SALES_EXEC'], { receivingLeads: false });
    const leader = await makeStaff('Leader', ['SALES_LEADER']);

    const first = oid();
    await assignNewParty(first, 'app');
    expect(String((await Holding.findOne({ partyId: first }))!.holderId)).toBe(String(a._id));
    expect(await uncalledOf(away)).toBe(0);

    await hold(oid(), a._id);
    const overflow = oid();
    await assignNewParty(overflow, 'app'); // A now has 2: at the cap
    expect(String((await Holding.findOne({ partyId: overflow }))!.holderId)).toBe(
      String(leader._id),
    );
  });

  it('never pushes anyone past the cap, even with 20 leads arriving at once', async () => {
    await setPolicy({ uncalledCap: 5 });
    const callers = await Promise.all(['A', 'B', 'C'].map((n) => makeStaff(n, ['SALES_EXEC'])));
    const leader = await makeStaff('Leader', ['SALES_LEADER']);
    await Promise.all(Array.from({ length: 20 }, () => assignNewParty(oid(), 'app')));
    for (const c of callers) expect(await uncalledOf(c)).toBe(5);
    expect(await Holding.countDocuments({ holderId: leader._id, isOpen: true })).toBe(5);
  }, 60_000);

  it('leaves the party in the Pool when there is nobody to take it — and does not throw', async () => {
    const party = oid();
    await expect(assignNewParty(party, 'app')).resolves.toBeUndefined();
    expect(await Holding.countDocuments({ partyId: party })).toBe(0);
  });

  it('a Sr. Sales Executive receives intake leads like a Sales Executive', async () => {
    const sr = await makeStaff('Sr', ['SR_SALES_EXEC']);
    const party = oid();
    await assignNewParty(party, 'app');
    expect(String((await Holding.findOne({ partyId: party }))!.holderId)).toBe(String(sr._id));
  });

  it("a caller's own call is his, and never counts as uncalled", async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    const party = oid();
    await assignNewParty(party, 'staff', String(caller._id));
    expect(await Holding.findOne({ partyId: party })).toMatchObject({
      via: 'own_call',
      source: 'call',
    });
    expect(await uncalledOf(caller)).toBe(0);
  });

  it('a buyer registered from the buyer app is dealt to a caller', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    await registerBuyer(
      {
        mobile: randomMobile(),
        firm: 'App Traders',
        gstin: await randomGstin(),
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      },
      undefined,
      'test',
    );
    const holding = await Holding.findOne({ isOpen: true });
    expect(String(holding!.holderId)).toBe(String(caller._id));
    expect(holding).toMatchObject({ via: 'intake', source: 'app' });
  });
});

describe('LOCK-34 §3 — uncalled', () => {
  beforeEach(() => setPolicy({ enabled: true, goLiveDate: '2026-01-01' }));

  it('any call removes the lead at once — "no answer" included; a note or an earlier call does not', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    const party = await makeParty();
    const started = ist('2026-02-01');
    await hold(party, caller._id, { startedAt: started });
    expect(await uncalledOf(caller)).toBe(1);

    await call(party, caller._id, days(started, -1)); // before it began
    await call(party, caller._id, days(started, 1), 'note'); // a bare note
    await call(party, oid(), days(started, 1)); // someone else rang him
    expect(await uncalledOf(caller)).toBe(1);

    await call(party, caller._id, days(started, 1)); // no_answer, by the holder
    expect(await uncalledOf(caller)).toBe(0);
  });

  it('go-live, own-call, conversion and transferred holdings never count', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    for (const via of ['go_live', 'own_call', 'conversion', 'transfer']) {
      await hold(oid(), caller._id, { via });
    }
    await hold(oid(), caller._id, { kind: 'book', via: 'go_live' });
    expect(await uncalledOf(caller)).toBe(0);
  });

  it('a rejected firm drops out of the count', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    const party = await makeParty({ status: 'rejected' });
    await hold(party, caller._id);
    expect(await uncalledOf(caller)).toBe(0);
  });
});

describe('LOCK-34 §4.7 — claim', () => {
  beforeEach(() => setPolicy({ enabled: true, goLiveDate: '2026-01-01', uncalledCap: 3 }));

  it('is refused at the cap, saying why', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    for (let i = 0; i < 3; i += 1) await hold(oid(), caller._id);
    const party = await makeParty();
    await expect(claimParty(party, actorOf(caller))).rejects.toMatchObject({
      messageEn: 'You have 3 uncalled. Call them first.',
    });
    const pool = await poolList(String(caller._id), { section: 'new' });
    expect(pool.claim).toEqual({ allowed: false, reason: 'You have 3 uncalled. Call them first.' });
  });

  it('two at once: exactly one holding is created, the other is told', async () => {
    const x = await makeStaff('X', ['SALES_EXEC']);
    const y = await makeStaff('Y', ['SALES_EXEC']);
    const party = await makeParty();
    const results = await Promise.allSettled([
      claimParty(party, actorOf(x)),
      claimParty(party, actorOf(y)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.messageEn).toBe('Already claimed by someone else.');
    expect(await Holding.countDocuments({ partyId: party, isOpen: true })).toBe(1);
  });

  it('a lead comes back as a lead, an ordered party as a claim; the last holder cannot take him back', async () => {
    const x = await makeStaff('X', ['SALES_EXEC']);
    const y = await makeStaff('Y', ['SR_SALES_EXEC']); // a Sr. Sales Executive claims like any caller
    const fresh = await makeParty();
    const ordered = await makeParty();
    await addBill(ordered, '2026-01-10', 20_000);

    await claimParty(fresh, actorOf(x));
    await claimParty(ordered, actorOf(y));
    expect(await Holding.findOne({ partyId: fresh })).toMatchObject({
      kind: 'lead',
      via: 'pool_claim',
    });
    expect(await Holding.findOne({ partyId: ordered })).toMatchObject({
      kind: 'claim',
      via: 'pool_claim',
    });
    // A claimed party counts as uncalled until the claimer rings him.
    expect(await uncalledOf(x)).toBe(1);

    await Holding.updateOne(
      { partyId: fresh },
      { $set: { isOpen: false, endedAt: new Date(), end: 'released' } },
    );
    await expect(claimParty(fresh, actorOf(x))).rejects.toMatchObject({
      messageEn: 'You held this party last, so another caller has to take him.',
    });
    await expect(claimParty(fresh, actorOf(y))).resolves.toBeTruthy();
  });

  it('a Team Leader cannot claim', async () => {
    const leader = await makeStaff('Leader', ['SALES_LEADER']);
    await expect(claimParty(await makeParty(), actorOf(leader))).rejects.toMatchObject({
      messageEn: 'Only a Sales Executive or Sr. Sales Executive can claim a party.',
    });
  });
});

describe('LOCK-34 §4.6, §4.8 — the Pool and the Team Leader', () => {
  beforeEach(() => setPolicy({ enabled: true, goLiveDate: '2026-01-01', unclaimedDays: 3 }));

  it('hides a party from the caller who held him last, shows him to another, longest waiting first', async () => {
    const last = await makeStaff('Last', ['SALES_EXEC']);
    const other = await makeStaff('Other', ['SALES_EXEC']);
    const third = await makeStaff('Third', ['SALES_EXEC']);
    const mine = await makeParty({ firm: 'Held Before' });
    const older = await makeParty({ firm: 'Older' });
    const newer = await makeParty({ firm: 'Newer' });
    await pastHold(mine, last._id, ist('2026-03-01'));
    await pastHold(older, third._id, ist('2026-02-01'), { reason: 'rate_too_high' });
    await pastHold(newer, third._id, ist('2026-02-20'), { systemMarked: true });

    const asLast = await poolList(String(last._id), { section: 'new' });
    expect(asLast.items.map((i) => i.firm)).toEqual(['Older', 'Newer']);
    const asOther = await poolList(String(other._id), { section: 'new' });
    expect(asOther.items.map((i) => i.firm)).toEqual(['Older', 'Newer', 'Held Before']);
    // The card carries the holder's story — and nothing private.
    const card = asOther.items[0]!;
    expect(card.previousHolders[0]).toMatchObject({ holder: 'Third', reason: 'rate_too_high' });
    expect(Object.keys(card).sort()).toEqual(
      [
        'buyerId',
        'district',
        'enteredAt',
        'firm',
        'previousHolders',
        'section',
        'state',
        'tehsil',
      ].sort(),
    );
    expect(asOther.items[1]!.previousHolders[0]!.systemMarked).toBe(true);
  });

  it('splits ordered parties from new leads, and searches name, tehsil and district only', async () => {
    const viewer = await makeStaff('Viewer', ['SALES_EXEC']);
    const ordered = await makeParty({
      firm: 'Alpha Agro',
      tehsil: { name: 'Mhow', district: 'Indore', state: 'MP' },
    });
    await makeParty({
      firm: 'Beta Seeds',
      tehsil: { name: 'Sanwer', district: 'Dewas', state: 'MP' },
    });
    await addBill(ordered, '2026-01-10', 500);

    const o = await poolList(String(viewer._id), { section: 'ordered' });
    const n = await poolList(String(viewer._id), { section: 'new' });
    expect(o.counts).toEqual({ ordered: 1, new: 1 });
    expect(o.items.map((i) => i.firm)).toEqual(['Alpha Agro']);
    expect(n.items.map((i) => i.firm)).toEqual(['Beta Seeds']);
    expect((await poolList(String(viewer._id), { section: 'new', q: 'dewas' })).items).toHaveLength(
      1,
    );
    expect(
      (await poolList(String(viewer._id), { section: 'new', q: 'sanwer' })).items,
    ).toHaveLength(1);
    expect((await poolList(String(viewer._id), { section: 'new', q: '9800' })).items).toHaveLength(
      0,
    );
  });

  it('never shows the zzzzz tehsil: the district and state are there instead, and it is not searchable', async () => {
    const viewer = await makeStaff('Viewer', ['SALES_EXEC']);
    await makeParty({
      firm: 'Far Away',
      tehsil: { name: 'zzzzz', district: 'Nashik', state: 'Maharashtra' },
    });
    const page = await poolList(String(viewer._id), { section: 'new' });
    expect(page.items[0]).toMatchObject({ tehsil: null, district: 'Nashik', state: 'Maharashtra' });
    expect(JSON.stringify(page)).not.toMatch(/zzzzz/i);
    expect((await poolList(String(viewer._id), { section: 'new', q: 'zzzzz' })).items).toHaveLength(
      0,
    );
    expect(
      (await poolList(String(viewer._id), { section: 'new', q: 'nashik' })).items,
    ).toHaveLength(1);
  });

  it('puts a party on the Team Leader’s list on day 3; Leave drops him until he next enters the Pool; Assign gives him to a caller', async () => {
    const leader = await makeStaff('Leader', ['SALES_LEADER']);
    const caller = await makeStaff('Caller', ['SALES_EXEC'], {
      reportsToSalesLeaderId: leader._id,
    });
    const party = await makeParty();
    const born = (await Buyer.findById(party))!.get('createdAt') as Date;

    expect((await teamLeaderQueue(actorOf(leader), days(born, 2))).items).toHaveLength(0);
    const day3 = await teamLeaderQueue(actorOf(leader), days(born, 3));
    expect(day3.items.map((i) => i.buyerId)).toEqual([party]);
    expect(day3.callers[0]).toMatchObject({ person: 'Caller', uncalled: 0, canSwitch: true });

    await leaveInPool(party, actorOf(leader));
    expect((await teamLeaderQueue(actorOf(leader), days(born, 5))).items).toHaveLength(0);

    // He is claimed, released, and re-enters the Pool: he is on the list again after 3 days.
    const reEntry = days(born, 10);
    await pastHold(party, caller._id, reEntry);
    expect((await teamLeaderQueue(actorOf(leader), days(reEntry, 3))).items).toHaveLength(1);

    // The earlier holder cannot be given him back; another caller can.
    await expect(assignFromPool(party, String(caller._id), actorOf(leader))).rejects.toMatchObject({
      messageEn: 'Caller held this party last — pick someone else.',
    });
    const next = await makeStaff('Next', ['SR_SALES_EXEC'], { reportsToSalesLeaderId: leader._id });
    const { holdingId } = await assignFromPool(party, String(next._id), actorOf(leader));
    expect(await Holding.findById(holdingId)).toMatchObject({ via: 'desk_assign', isOpen: true });
  });

  it('only a Team Leader or Admin may use the list; a caller switches nobody', async () => {
    const caller = await makeStaff('Caller', ['SALES_EXEC']);
    await expect(teamLeaderQueue(actorOf(caller))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      setReceivingLeads(String(caller._id), false, actorOf(caller)),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('a Team Leader switches intake off for his own caller (and not another team’s)', async () => {
    const leader = await makeStaff('Leader', ['SALES_LEADER']);
    const other = await makeStaff('Other Leader', ['SALES_LEADER']);
    const mine = await makeStaff('Mine', ['SALES_EXEC'], { reportsToSalesLeaderId: leader._id });
    const theirs = await makeStaff('Theirs', ['SALES_EXEC'], { reportsToSalesLeaderId: other._id });
    await setReceivingLeads(String(mine._id), false, actorOf(leader));
    expect((await Employee.findById(mine._id))!.receivingLeads).toBe(false);
    await expect(
      setReceivingLeads(String(theirs._id), false, actorOf(leader)),
    ).rejects.toMatchObject({
      messageEn: 'Theirs is not in your team.',
    });
  });
});

describe('LOCK-34 §4.3–4.4, §7 — the nightly clocks', () => {
  beforeEach(() => setPolicy({ enabled: true, goLiveDate: '2025-12-01' }));

  async function bookFor(holder: { _id: unknown }, bills: Array<[string, number]>) {
    const party = await makeParty();
    for (const [day, rupees] of bills) await addBill(party, day, rupees);
    await hold(party, holder._id, { kind: 'book', via: 'go_live', startedAt: ist('2025-12-01') });
    return party;
  }

  it('opens the window on day 90 and, with no reason, releases on day 97 as "owner did not diagnose"', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const other = await makeStaff('Other', ['SALES_EXEC']);
    const party = await bookFor(holder, [['2026-01-01', 10_000]]);

    await runDormancyClocks(ist('2026-03-31'));
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toBeUndefined(); // day 89

    await runDormancyClocks(ist('2026-04-01'));
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toEqual(ist('2026-04-01'));

    await runDormancyClocks(ist('2026-04-07'));
    expect((await Holding.findOne({ partyId: party }))!.isOpen).toBe(true); // still the holder's

    await runDormancyClocks(ist('2026-04-08'));
    const released = await Holding.findOne({ partyId: party });
    expect(released).toMatchObject({ isOpen: false, end: 'released', systemMarked: true });
    expect(await BookAssignment.countDocuments({ buyerId: party })).toBe(0);

    const pool = await poolList(String(other._id), { section: 'ordered' });
    expect(pool.items.map((i) => i.buyerId)).toEqual([party]);
    expect(pool.items[0]!.previousHolders[0]).toMatchObject({
      holder: 'Holder',
      systemMarked: true,
    });
  });

  it('a logged reason is kept (and can be changed) but does not release early', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const party = await bookFor(holder, [['2026-01-01', 10_000]]);
    const h = (await Holding.findOne({ partyId: party }))!;
    await expect(
      logReason(String(h._id), 'rate_too_high', String(holder._id)),
    ).rejects.toMatchObject({
      messageEn: 'The time to give a reason for this party has not started, or is over.',
    });

    await runDormancyClocks(ist('2026-04-01'));
    await logReason(String(h._id), 'rate_too_high', String(holder._id));
    await logReason(String(h._id), 'already_holds_stock', String(holder._id)); // changed his mind
    await expect(logReason(String(h._id), 'rate_too_high', String(oid()))).rejects.toMatchObject({
      messageEn: 'Only the person holding this party can give the reason.',
    });
    expect((await Holding.findById(h._id))!.isOpen).toBe(true);

    await runDormancyClocks(ist('2026-04-08'));
    expect(await Holding.findById(h._id)).toMatchObject({
      isOpen: false,
      reason: 'already_holds_stock',
      systemMarked: false,
    });
  });

  it('a restart while the window is open cancels it, and the holder keeps the party', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const party = await bookFor(holder, [['2026-01-01', 10_000]]);
    await runDormancyClocks(ist('2026-04-01'));
    await addBill(party, '2026-04-03', 10_000);
    await runDormancyClocks(ist('2026-04-04'));
    const h = (await Holding.findOne({ partyId: party }))!;
    expect(h.isOpen).toBe(true);
    expect(h.windowOpenedAt).toBeUndefined();
    // And the new clock runs from the restart: day 90 after 03/04 is 02/07.
    await runDormancyClocks(ist('2026-07-01'));
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toBeUndefined();
    await runDormancyClocks(ist('2026-07-02'));
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toBeTruthy();
  });

  it('a lead converts on its first bill, of any amount, to a book starting on that bill’s date', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const party = await makeParty();
    await hold(party, holder._id, { kind: 'lead', via: 'intake', startedAt: ist('2026-02-01') });
    await addBill(party, '2026-02-10', 500);
    await runDormancyClocks(ist('2026-02-11'));
    const all = await Holding.find({ partyId: party }).sort({ createdAt: 1 });
    expect(all[0]).toMatchObject({ isOpen: false, end: 'ordered' });
    expect(all[1]).toMatchObject({ kind: 'book', via: 'conversion', isOpen: true });
    expect(String(all[1]!.holderId)).toBe(String(holder._id));
    expect(all[1]!.startedAt).toEqual(ist('2026-02-10'));
  });

  it('a lead with no bill gets its window on day 60 and is released on day 67', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const party = await makeParty();
    await hold(party, holder._id, { startedAt: ist('2026-02-01') });
    await runDormancyClocks(ist('2026-04-01')); // day 59
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toBeUndefined();
    await runDormancyClocks(ist('2026-04-02')); // day 60
    expect((await Holding.findOne({ partyId: party }))!.windowOpenedAt).toBeTruthy();
    await runDormancyClocks(ist('2026-04-09')); // day 67
    expect((await Holding.findOne({ partyId: party }))!.isOpen).toBe(false);
  });

  it('an expired claim ends with the claimer as last holder, his reason on the card', async () => {
    const claimer = await makeStaff('Claimer', ['SALES_EXEC']);
    const viewer = await makeStaff('Viewer', ['SALES_EXEC']);
    const party = await makeParty();
    await addBill(party, '2025-10-01', 20_000);
    const d = ist('2026-02-01');
    const h = await hold(party, claimer._id, { kind: 'claim', via: 'pool_claim', startedAt: d });
    await runDormancyClocks(days(d, 60));
    await logReason(String(h._id), 'wants_something_we_dont_stock', String(claimer._id));
    await runDormancyClocks(days(d, 67));
    expect((await Holding.findById(h._id))!.isOpen).toBe(false);
    const card = (await poolList(String(viewer._id), { section: 'ordered' })).items[0]!;
    expect(card.previousHolders[0]).toMatchObject({
      holder: 'Claimer',
      reason: 'wants_something_we_dont_stock',
    });
    expect((await poolList(String(claimer._id), { section: 'ordered' })).items).toHaveLength(0);
  });

  it('a claim converts to a book on a restart after it began', async () => {
    const claimer = await makeStaff('Claimer', ['SALES_EXEC']);
    const party = await makeParty();
    await addBill(party, '2025-10-01', 20_000);
    await hold(party, claimer._id, {
      kind: 'claim',
      via: 'pool_claim',
      startedAt: ist('2026-02-01'),
    });
    await runDormancyClocks(ist('2026-02-05')); // no new bill yet: stays a claim
    expect((await Holding.findOne({ partyId: party, isOpen: true }))!.kind).toBe('claim');
    await addBill(party, '2026-02-10', 12_000);
    await runDormancyClocks(ist('2026-02-11'));
    const book = (await Holding.findOne({ partyId: party, isOpen: true }))!;
    expect(book).toMatchObject({ kind: 'book', via: 'conversion' });
    expect(String(book.holderId)).toBe(String(claimer._id));
    expect(book.startedAt).toEqual(ist('2026-02-10'));
    expect(await Holding.findOne({ partyId: party, end: 'billed' })).toBeTruthy();
  });

  it('releases a rejected firm’s holding quietly, and it never reaches the Pool', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const viewer = await makeStaff('Viewer', ['SALES_EXEC']);
    const party = await makeParty({ status: 'rejected' });
    await hold(party, holder._id);
    await runDormancyClocks(ist('2026-02-01'));
    expect((await Holding.findOne({ partyId: party }))!.isOpen).toBe(false);
    expect((await poolList(String(viewer._id), { section: 'new' })).items).toHaveLength(0);
  });

  it('is idempotent: a second run on the same day changes nothing', async () => {
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const a = await bookFor(holder, [['2026-01-01', 10_000]]);
    const b = await makeParty();
    await hold(b, holder._id, { startedAt: ist('2026-02-01') });
    for (const day of ['2026-04-01', '2026-04-02', '2026-04-08']) {
      await runDormancyClocks(ist(day));
      const snapshot = JSON.stringify(await Holding.find().sort({ _id: 1 }).lean());
      const again = await runDormancyClocks(ist(day));
      expect(again).toMatchObject({
        converted: 0,
        windowsOpened: 0,
        released: 0,
        backlogOpened: 0,
      });
      expect(JSON.stringify(await Holding.find().sort({ _id: 1 }).lean())).toBe(snapshot);
    }
    expect(a).toBeTruthy();
  });

  it('does nothing at all while the switch is off', async () => {
    await setPolicy({ enabled: false });
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    await bookFor(holder, [['2026-01-01', 10_000]]);
    expect(await runDormancyClocks(ist('2026-06-01'))).toBeNull();
    expect((await Holding.findOne())!.windowOpenedAt).toBeUndefined();
  });
});

describe('LOCK-34 §4.9 — backlog at go-live', () => {
  it('opens 100 windows a week, oldest last bill first; a backlog party who bills leaves the backlog', async () => {
    await setPolicy({ enabled: true, goLiveDate: '2026-11-03' });
    const holder = await makeStaff('Holder', ['SALES_EXEC']);
    const parties = Array.from({ length: 250 }, () => oid());
    const orders = parties.map((buyerId, i) => ({
      _id: oid(),
      soNo: `SO-B-${i}`,
      chainId: oid(),
      buyerId,
      sellerId: oid(),
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'billed_in_marg',
      payDeadline: new Date(),
      totalPaise: 2_000_000,
    }));
    await So.insertMany(orders);
    await MargBill.insertMany(
      orders.map((o, i) => ({
        margInvoiceNo: `INV-B-${i}`,
        soId: o._id,
        placeOfSupply: 'intra_state',
        taxSplit: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
        valuePaise: 2_000_000,
        ewayNo: 'E1',
        state: 'matched',
        keyedBy: oid(),
        keyedAt: days(ist('2025-01-01'), i), // party 0 has the oldest last bill
      })),
    );
    const settings = await getSettings();
    for (const [i, party] of parties.entries()) {
      const bills = (await billsForMany([String(party)], settings.goLiveDate)).get(String(party))!;
      await openGoLiveHolding(String(party), String(holder._id), settings, bills);
      if (i === 0) {
        expect(await Holding.findOne({ partyId: party })).toMatchObject({
          backlog: true,
          via: 'go_live',
        });
      }
    }
    expect(await Holding.countDocuments({ backlog: true })).toBe(250);

    // Party 249 bills before his turn comes.
    await addBill(String(parties[249]), '2026-11-02', 15_000);

    const goLive = ist('2026-11-03');
    const opened = async () =>
      Holding.find({ windowOpenedAt: { $ne: null } })
        .sort({ _id: 1 })
        .lean();
    expect((await runDormancyClocks(goLive))!.backlogOpened).toBe(100);
    const week1 = await opened();
    expect(week1).toHaveLength(100);
    const firstHundred = new Set(parties.slice(0, 100).map(String));
    expect(week1.every((h) => firstHundred.has(String(h.partyId)))).toBe(true); // oldest bills first
    expect((await Holding.findOne({ partyId: parties[249] }))!.backlog).toBeFalsy(); // left the backlog

    expect((await runDormancyClocks(days(goLive, 3)))!.backlogOpened).toBe(0); // same week
    expect((await runDormancyClocks(days(goLive, 7)))!.backlogOpened).toBe(100); // week 2
    expect((await runDormancyClocks(days(goLive, 14)))!.backlogOpened).toBe(49); // week 3: the rest
    const left = await Holding.countDocuments({
      isOpen: true,
      backlog: true,
      windowOpenedAt: null,
    });
    expect(left).toBe(0);
  }, 120_000);
});

describe('LOCK-34 §4.2 — bills are counted once', () => {
  it('a Marg-imported bill already on a platform order is not counted twice; one after go-live is ignored', async () => {
    await setPolicy({ enabled: true, goLiveDate: '2026-01-01' });
    const party = await makeParty();
    await addBill(party, '2026-02-01', 10_000, 'INV-100'); // on the platform, after go-live
    await MargBillImport.create([
      {
        gstin: 'G',
        partyId: party,
        invoiceNo: 'inv-100 ',
        invoiceKey: 'INV-100',
        billDate: ist('2025-12-20'),
        netPaise: 1_000_000,
      },
      {
        gstin: 'G',
        partyId: party,
        invoiceNo: 'INV-7',
        invoiceKey: 'INV-7',
        billDate: ist('2025-12-01'),
        netPaise: 300_000,
      },
      {
        gstin: 'G',
        partyId: party,
        invoiceNo: 'INV-8',
        invoiceKey: 'INV-8',
        billDate: ist('2026-01-05'),
        netPaise: 300_000,
      },
    ]);
    const bills = await billsFor(party, '2026-01-01');
    expect(bills.map((b) => b.netPaise).sort((a, b) => a - b)).toEqual([300_000, 1_000_000]);
  });
});

describe('LOCK-34 §12.1 — placeholders are never matched', () => {
  it('two parties on placeholder mobiles are never matched to each other or to an import row', async () => {
    for (const mobile of ['9999999991', '9999999992']) {
      const cp = await Counterparty.create({
        mobile,
        contactMobile: mobile,
        firm: mobile,
        kind: 'buyer',
        status: 'active',
      });
      await Buyer.create({ counterpartyId: cp._id });
    }
    expect(isPlaceholderMobile('9999999991')).toBe(true);
    expect(await matchParty(undefined, '9999999991')).toHaveProperty('reason');
    expect(await matchParty(undefined, '9999999992')).toHaveProperty('reason');
  });

  it('matches by GSTIN, then by a real mobile, and calls a shared mobile ambiguous', async () => {
    const gstin = await randomGstin();
    const cp = await Counterparty.create({
      mobile: '9811111111',
      contactMobile: '9811111111',
      firm: 'G Co',
      gstin,
      kind: 'buyer',
      status: 'active',
    });
    const buyer = await Buyer.create({ counterpartyId: cp._id });
    expect(await matchParty(gstin, undefined)).toEqual({ buyerId: String(buyer._id) });
    expect(await matchParty(undefined, '9811111111')).toEqual({ buyerId: String(buyer._id) });
    const twin = await Counterparty.create({
      mobile: null,
      contactMobile: '9811111111',
      firm: 'Twin',
      kind: 'buyer',
      status: 'active',
    });
    await Buyer.create({ counterpartyId: twin._id });
    expect(await matchParty(undefined, '9811111111')).toMatchObject({
      reason: 'more than one buyer uses that mobile',
    });
  });
});

describe('LOCK-34 — old ways of moving a buyer are switched off, and a leaver’s parties move with him', () => {
  it('Change owner / assign is refused, and the button is hidden, while the rules are on', async () => {
    await setPolicy({ enabled: true, goLiveDate: '2026-01-01' });
    const leader = await makeStaff('Leader', ['SALES_LEADER']);
    const party = await makeParty();
    const actor = { ...actorOf(leader), permissions: ['buyer:admin'] };
    await expect(
      moveLead('sales', party, String(leader._id), actor, { leadersOnly: true }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await mayChangeOwner('sales', actor, null)).toBe(false);
  });

  it('transfer hands every open holding to the heir, and the heir is not flooded with "uncalled"', async () => {
    await setPolicy({ enabled: true, goLiveDate: '2026-01-01' });
    const leaver = await makeStaff('Leaver', ['SALES_EXEC']);
    const heir = await makeStaff('Heir', ['SALES_EXEC']);
    for (let i = 0; i < 4; i += 1) await hold(oid(), leaver._id);
    expect(await uncalledOf(leaver)).toBe(4);
    await withTransaction((session) =>
      transferHoldings(leaver._id as Types.ObjectId, heir._id as Types.ObjectId, session),
    );
    expect(await Holding.countDocuments({ holderId: heir._id, isOpen: true })).toBe(4);
    expect(await uncalledOf(heir)).toBe(0);
  });
});

describe('LOCK-34 §4.1 — the Dormant policy page’s API', () => {
  it('refuses a bad value in plain words, will not switch on without a go-live date, and logs each change', async () => {
    const admin = await staffToken(app, 'admin');
    const put = (body: object) =>
      request(app)
        .put('/api/v1/admin/dormancy-policy')
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', `p-${Math.random()}`)
        .send(body);

    const bad = await put({ orderedDays: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message_en).toMatch(/at least 1/);

    const early = await put({ enabled: true });
    expect(early.body.error.message_en).toBe('Set the go-live date before switching this on.');

    const ok = await put({ goLiveDate: '2026-11-03', billingThresholdPaise: 1_500_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings).toMatchObject({
      goLiveDate: '2026-11-03',
      billingThresholdPaise: 1_500_000,
      orderedDays: 90,
    });
    expect(
      await AuditLog.countDocuments({ entity: 'config', field: 'dormancy.billingThreshold' }),
    ).toBe(1);

    const get = await request(app)
      .get('/api/v1/admin/dormancy-policy')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(get.body.data.nightlyJobEnabled).toBe(false);
  });
});

describe('LOCK-34 — a caller can use the API end to end', () => {
  it('shows status, claims a party over HTTP, and the claim is idempotent', async () => {
    await setPolicy({ enabled: true, goLiveDate: '2026-01-01' });
    const email = randomEmail();
    const sales = await Role.findOne({ key: 'sales' });
    const caller = await Employee.create({
      person: 'Http Caller',
      email,
      passwordHash: await bcrypt.hash('CorrectHorse123', 10),
      roleIds: [sales!._id],
      positions: ['SR_SALES_EXEC'],
      active: true,
    });
    const token = await loginStaff(app, email, 'CorrectHorse123');
    const party = await makeParty({ firm: 'Http Firm' });

    const status = await request(app)
      .get('/api/v1/staff/sales/holdings/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.data).toMatchObject({ enabled: true, isCaller: true, isTeamLeader: false });

    const pool = await request(app)
      .get('/api/v1/staff/sales/party-pool?section=new')
      .set('Authorization', `Bearer ${token}`);
    expect(pool.body.data.items[0].firm).toBe('Http Firm');
    expect(pool.body.data.claim.allowed).toBe(true);

    const key = `claim-${Math.random()}`;
    const claim = () =>
      request(app)
        .post(`/api/v1/staff/sales/party-pool/${party}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key);
    const first = await claim();
    expect(first.status).toBe(201);
    const replay = await claim();
    expect(replay.status).toBe(201);
    expect(replay.body.data.holdingId).toBe(first.body.data.holdingId);
    expect(
      await Holding.countDocuments({ partyId: party, holderId: caller._id, isOpen: true }),
    ).toBe(1);

    const mine = await request(app)
      .get('/api/v1/staff/sales/holdings/mine')
      .set('Authorization', `Bearer ${token}`);
    expect(mine.body.data.items[0]).toMatchObject({
      firm: 'Http Firm',
      kind: 'lead',
      uncalled: true,
    });
    expect(mine.body.data.uncalled).toBe(1);
  });
});
