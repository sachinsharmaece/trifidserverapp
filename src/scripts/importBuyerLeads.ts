import { readFileSync, writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { ROLE_SEED } from '../config/permissions.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { State } from '../models/State.js';
import { District } from '../models/District.js';
import { Tehsil } from '../models/Tehsil.js';
import { registerBuyerByStaff } from '../modules/onboarding/buyer.registration.js';
import type { StaffBuyerInput } from '../modules/onboarding/buyer.registration.js';
import { checkBuyerIdentity } from '../modules/onboarding/buyer.identity.js';
import { staffRegisterBuyerSchema } from '../modules/onboarding/onboarding.validation.js';
import { assertLocationChain } from '../modules/territory/territory.masters.js';
import { assertMayAssignBuyer } from '../shared/team.js';

/**
 * 30 Oct — load a dealer lead list (the IMPORT tab of a "<name>_leads_import"
 * sheet, downloaded as CSV) as buyers, through the same `registerBuyerByStaff`
 * the Register a buyer form uses: same checks, same audit entry, each buyer
 * pending with his Assigned to set. Registered as Admin.
 *
 * - The sheet's PAN is a dummy, so it is dropped: the buyer is saved with
 *   neither GSTIN nor PAN (DEC-068).
 * - The proprietor-agreed tick is set on every row; the call note says it
 *   came from this import and who vouched for consent (--consent-by).
 * - Rows marked "NO MATCH in app" are skipped. A mobile some firm already
 *   uses is skipped too (never auto-confirmed), so a re-run after a partial
 *   apply only adds what is missing.
 * - Only "Same-name post office" pincodes are kept; the fallback and
 *   similar-name ones are guesses and would seed the pincode master wrongly.
 *
 *   npm run import:buyerLeads -- <file.csv> --consent-by "Rajat" --source "YADAV.xlsx"
 *       dry run: checks every row against the DB, writes nothing
 *   ... --apply                    registers them
 *   ... --report <out.csv>         writes one line per row with its outcome
 */
const ADMIN_PERMISSIONS = ROLE_SEED.find((r) => r.key === 'admin')!.permissionKeys as string[];

type Row = Record<string, string>;
type Outcome = { row: Row; status: 'ok' | 'skip' | 'fail'; why: string };

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at > -1 ? process.argv[at + 1] : undefined;
}

/** RFC 4180 enough for a Google Sheets CSV export: quotes, doubled quotes, newlines in a cell. */
function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  if (field || record.length) records.push([...record, field]);
  const [header, ...body] = records.filter((r) => r.some((cell) => cell.trim()));
  if (!header) return [];
  const keys = header.map((h) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h).trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

async function run(): Promise<void> {
  const file = process.argv[2];
  const consentBy = arg('--consent-by');
  const source = arg('--source');
  const reportPath = arg('--report');
  const apply = process.argv.includes('--apply');
  if (!file || file.startsWith('--') || !consentBy || !source) {
    throw new Error('Usage: <file.csv> --consent-by "<name>" --source "<file name>" [--apply]');
  }
  const rows = parseCsv(readFileSync(file, 'utf8'));

  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);

  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  const admin = await Employee.findOne({ roleIds: adminRole?._id, active: true }).sort({ _id: 1 });
  if (!admin) throw new Error('No active Admin to register as.');
  const caller = {
    employeeId: String(admin._id),
    permissions: ADMIN_PERMISSIONS,
    correlationId: `lead-import-${new Date().toISOString().slice(0, 10)}`,
  };

  // Names → ids, by district, never by tehsil name alone (thirteen repeat in MP).
  const states = new Map((await State.find()).map((s) => [key(s.name), s]));
  const districts = new Map(
    (await District.find()).map((d) => [`${String(d.stateId)}|${key(d.name)}`, d]),
  );
  const tehsils = new Map<string, InstanceType<typeof Tehsil>[]>();
  for (const t of await Tehsil.find({ districtId: { $ne: null } })) {
    const k = `${String(t.districtId)}|${key(t.name)}`;
    tehsils.set(k, [...(tehsils.get(k) ?? []), t]);
  }

  const outcomes: Outcome[] = [];
  for (const row of rows) {
    const done = (status: Outcome['status'], why: string) => outcomes.push({ row, status, why });
    if (row['Tehsil match'] === 'NO MATCH in app') {
      done('skip', 'tehsil not in the app (NO MATCH)');
      continue;
    }
    const state = states.get(key(row['State'] ?? ''));
    const district = state && districts.get(`${String(state._id)}|${key(row['District'] ?? '')}`);
    const found = district
      ? tehsils.get(`${String(district._id)}|${key(row['Tehsil'] ?? '')}`)
      : [];
    if (!state || !district || found?.length !== 1) {
      done(
        'fail',
        !state
          ? `state "${row['State']}" not found`
          : !district
            ? `district "${row['District']}" not found`
            : `tehsil "${row['Tehsil']}" ${found?.length ? 'is ambiguous' : 'not found'} in ${district.name}`,
      );
      continue;
    }

    const rawAddress = row['Address (tehsil used as village)'] ?? '';
    const otherMobiles = row['Other mobiles'] ?? '';
    const parsed = staffRegisterBuyerSchema.safeParse({
      mobile: row['Mobile'],
      firm: row['Firm name'],
      ownerName: row['Proprietor name'],
      category: row['Category'],
      location: {
        // The form wants five characters; a short tehsil name gets its district.
        address: rawAddress.length >= 5 ? rawAddress : `${rawAddress}, ${district.name}`,
        pincode: row['Pincode basis'] === 'Same-name post office' ? row['Pincode'] : undefined,
        stateId: String(state._id),
        districtId: String(district._id),
        tehsilId: String(found[0]!._id),
      },
      assignedToEmployeeId: row['Assigned to (user id)'] || null,
      consent: { noticeVersion: 'v1', marketingOptIn: false },
      callNote: [
        `Imported from the lead list ${source}; proprietor consent to register as given by ${consentBy}.`,
        otherMobiles && `Other mobiles: ${otherMobiles}.`,
      ]
        .filter(Boolean)
        .join(' '),
      proprietorAgreed: true,
    });
    if (!parsed.success) {
      done('fail', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      continue;
    }
    const input = parsed.data as StaffBuyerInput;

    try {
      if (apply) {
        await registerBuyerByStaff(input, caller);
      } else {
        // The checks registerBuyerByStaff runs before it writes.
        await checkBuyerIdentity({
          mode: 'staff',
          mobile: input.mobile,
          stateId: input.location.stateId,
        });
        await assertLocationChain(input.location);
        await assertMayAssignBuyer(caller, input.assignedToEmployeeId ?? null);
      }
      done('ok', apply ? 'registered' : 'would register');
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      done(code === 'CONFIRMATION_REQUIRED' ? 'skip' : 'fail', message);
    }
  }

  const count = (s: Outcome['status']) => outcomes.filter((o) => o.status === s).length;
  console.log(
    `${apply ? 'Applied' : 'Dry run — nothing written'}. Rows: ${rows.length} — ` +
      `${apply ? 'registered' : 'would register'}: ${count('ok')}, skipped: ${count('skip')}, failed: ${count('fail')}. ` +
      `Registering as ${admin.person}.`,
  );
  for (const o of outcomes.filter((x) => x.status !== 'ok')) {
    console.log(`  ${o.status}  ${o.row['S.No (sheet)']}  ${o.row['Firm name']} — ${o.why}`);
  }
  if (reportPath) {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    writeFileSync(
      reportPath,
      [
        'S.No,Firm name,Mobile,Outcome,Why',
        ...outcomes.map((o) =>
          [
            o.row['S.No (sheet)'] ?? '',
            o.row['Firm name'] ?? '',
            o.row['Mobile'] ?? '',
            o.status,
            o.why,
          ]
            .map(cell)
            .join(','),
        ),
      ].join('\n'),
    );
    console.log(`Report: ${reportPath}`);
  }
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Lead import failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
