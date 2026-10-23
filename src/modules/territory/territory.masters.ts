import type { ClientSession, Types } from 'mongoose';
import { State } from '../../models/State.js';
import { District } from '../../models/District.js';
import { Tehsil } from '../../models/Tehsil.js';
import { Pincode } from '../../models/Pincode.js';
import { Employee } from '../../models/Employee.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { isValidPincode } from '../../shared/validators.js';

/**
 * Phase 1 location masters — State → District → Tehsil, and Pincode → Tehsil.
 * Every write is audited (DEC-065). Names are title-cased and trimmed once,
 * here, and every duplicate check is case-insensitive (the B-52 lesson:
 * "ujjain" and "Ujjain" are one place).
 */
export interface MasterActor {
  employeeId: string;
  correlationId: string;
}

const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

const id = (value: unknown): string => String(value);

// B-52 — moved here from territory.service.ts so every master shares it.
export function toTitleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// A state name keeps its own small words ("Jammu and Kashmir"), so only the
// first letter of each word is raised; the rest is left as typed.
function tidyStateName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && ['and', 'of'].includes(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export interface StateDto {
  stateId: string;
  name: string;
  gstStateCode: string;
}

export async function listStates(): Promise<StateDto[]> {
  const states = await State.find().collation(CASE_INSENSITIVE).sort({ name: 1 });
  return states.map((s) => ({ stateId: id(s._id), name: s.name, gstStateCode: s.gstStateCode }));
}

export async function createState(
  input: { name: string; gstStateCode: string },
  actor: MasterActor,
): Promise<StateDto> {
  const name = tidyStateName(input.name);
  const gstStateCode = input.gstStateCode.trim();
  const byName = await State.findOne({ name }).collation(CASE_INSENSITIVE);
  if (byName) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${byName.name} is already in the list.`,
      field: 'name',
    });
  }
  const byCode = await State.findOne({ gstStateCode });
  if (byCode) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `GST state code ${gstStateCode} already belongs to ${byCode.name}.`,
      field: 'gstStateCode',
    });
  }
  const state = await State.create({ name, gstStateCode });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'state',
    entityId: state._id as Types.ObjectId,
    field: 'create',
    newValue: { name, gstStateCode },
    correlationId: actor.correlationId,
  });
  return { stateId: id(state._id), name, gstStateCode };
}

// ---------------------------------------------------------------------------
// Districts
// ---------------------------------------------------------------------------

export interface DistrictDto {
  districtId: string;
  name: string;
  stateId: string;
  stateName: string;
}

export async function listDistricts(stateId?: string): Promise<DistrictDto[]> {
  if (stateId) assertValidObjectId(stateId, 'stateId');
  const districts = await District.find(stateId ? { stateId } : {})
    .collation(CASE_INSENSITIVE)
    .sort({ name: 1 });
  const states = await State.find({ _id: { $in: districts.map((d) => d.stateId) } });
  const stateName = new Map(states.map((s) => [id(s._id), s.name]));
  return districts.map((d) => ({
    districtId: id(d._id),
    name: d.name,
    stateId: id(d.stateId),
    stateName: stateName.get(id(d.stateId)) ?? '—',
  }));
}

async function requireState(stateId: string) {
  assertValidObjectId(stateId, 'stateId');
  const state = await State.findById(stateId);
  if (!state) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick a state from the list.',
      field: 'stateId',
    });
  }
  return state;
}

export async function createDistrict(
  input: { name: string; stateId: string },
  actor: MasterActor,
): Promise<DistrictDto> {
  const state = await requireState(input.stateId);
  const name = toTitleCase(input.name);
  const existing = await District.findOne({ stateId: state._id, name }).collation(CASE_INSENSITIVE);
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${existing.name} is already a district of ${state.name}.`,
      field: 'name',
    });
  }
  const district = await District.create({ name, stateId: state._id });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'district',
    entityId: district._id as Types.ObjectId,
    field: 'create',
    newValue: { name, stateId: input.stateId },
    correlationId: actor.correlationId,
  });
  return { districtId: id(district._id), name, stateId: id(state._id), stateName: state.name };
}

/**
 * Finds a district by state and name (case-insensitive), creating it if it
 * does not exist yet. For scripts and the migration — no audit row, no
 * actor; staff-facing creation goes through `createDistrict`.
 */
export async function ensureDistrict(
  stateId: Types.ObjectId | string,
  rawName: string,
): Promise<{ districtId: string; name: string; created: boolean }> {
  const name = toTitleCase(rawName);
  const existing = await District.findOne({ stateId, name }).collation(CASE_INSENSITIVE);
  if (existing) return { districtId: id(existing._id), name: existing.name, created: false };
  const district = await District.create({ name, stateId });
  return { districtId: id(district._id), name, created: true };
}

// ---------------------------------------------------------------------------
// Tehsils
// ---------------------------------------------------------------------------

export interface TehsilDto {
  tehsilId: string;
  name: string;
  district: string;
  state: string;
  districtId: string | null;
  stateId: string | null;
}

export async function listTehsils(filter: {
  districtId?: string;
  district?: string;
}): Promise<TehsilDto[]> {
  const query: Record<string, unknown> = {};
  if (filter.districtId) {
    assertValidObjectId(filter.districtId, 'districtId');
    query.districtId = filter.districtId;
  }
  if (filter.district) query.district = filter.district;
  const tehsils = await Tehsil.find(query)
    .collation(CASE_INSENSITIVE)
    .sort({ district: 1, name: 1 });
  const districts = await District.find({
    _id: { $in: tehsils.map((t) => t.districtId).filter(Boolean) },
  });
  const stateIdByDistrict = new Map(districts.map((d) => [id(d._id), id(d.stateId)]));
  return tehsils.map((t) => ({
    tehsilId: id(t._id),
    name: t.name,
    district: t.district,
    state: t.state,
    districtId: t.districtId ? id(t.districtId) : null,
    stateId: t.districtId ? (stateIdByDistrict.get(id(t.districtId)) ?? null) : null,
  }));
}

async function requireDistrictWithState(districtId: string) {
  assertValidObjectId(districtId, 'districtId');
  const district = await District.findById(districtId);
  if (!district) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick a district from the list.',
      field: 'districtId',
    });
  }
  const state = await State.findById(district.stateId);
  if (!state) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That district has no state.',
      field: 'districtId',
    });
  }
  return { district, state };
}

// One name per district, case-insensitively, against both the master link
// and the older free-text district (BR-080: the name alone is never a key).
async function assertTehsilNameFree(
  name: string,
  districtId: Types.ObjectId,
  districtName: string,
  exceptTehsilId?: string,
): Promise<void> {
  const clash = await Tehsil.findOne({
    name,
    $or: [{ districtId }, { district: districtName }],
    ...(exceptTehsilId ? { _id: { $ne: exceptTehsilId } } : {}),
  }).collation(CASE_INSENSITIVE);
  if (clash) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${clash.name} already exists in ${districtName}.`,
      field: 'name',
    });
  }
}

export async function createTehsil(
  input: { name: string; districtId: string },
  actor: MasterActor,
): Promise<{ tehsilId: string }> {
  const { district, state } = await requireDistrictWithState(input.districtId);
  const name = toTitleCase(input.name);
  await assertTehsilNameFree(name, district._id as Types.ObjectId, district.name);
  const tehsil = await Tehsil.create({
    name,
    districtId: district._id,
    district: district.name,
    state: state.name,
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'tehsil',
    entityId: tehsil._id as Types.ObjectId,
    field: 'create',
    newValue: { name, districtId: input.districtId },
    correlationId: actor.correlationId,
  });
  return { tehsilId: id(tehsil._id) };
}

export async function updateTehsil(
  tehsilId: string,
  input: { name?: string; districtId?: string },
  actor: MasterActor,
): Promise<TehsilDto> {
  assertValidObjectId(tehsilId, 'tehsilId');
  const tehsil = await Tehsil.findById(tehsilId);
  if (!tehsil) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Tehsil not found.' });
  const targetDistrictId = input.districtId ?? (tehsil.districtId ? id(tehsil.districtId) : null);
  if (!targetDistrictId) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick the district this tehsil belongs to.',
      field: 'districtId',
    });
  }
  const { district, state } = await requireDistrictWithState(targetDistrictId);
  const name = input.name !== undefined ? toTitleCase(input.name) : tehsil.name;
  await assertTehsilNameFree(name, district._id as Types.ObjectId, district.name, tehsilId);

  const before = {
    name: tehsil.name,
    districtId: tehsil.districtId ? id(tehsil.districtId) : null,
  };
  tehsil.name = name;
  tehsil.districtId = district._id as Types.ObjectId;
  tehsil.district = district.name;
  tehsil.state = state.name;
  await tehsil.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'tehsil',
    entityId: tehsil._id as Types.ObjectId,
    field: 'edit',
    oldValue: before,
    newValue: { name, districtId: id(district._id) },
    correlationId: actor.correlationId,
  });
  return {
    tehsilId,
    name,
    district: district.name,
    state: state.name,
    districtId: id(district._id),
    stateId: id(state._id),
  };
}

// ---------------------------------------------------------------------------
// Pincodes
// ---------------------------------------------------------------------------

export interface PincodeLocationDto {
  pincode: string;
  status: 'verified' | 'unverified';
  tehsilId: string;
  tehsilName: string;
  districtId: string | null;
  districtName: string;
  stateId: string | null;
  stateName: string;
}

export interface PincodeListItemDto extends PincodeLocationDto {
  createdByName: string | null;
  verifiedByName: string | null;
  createdAt: Date;
}

function assertPincodeShape(pincode: string): void {
  if (!isValidPincode(pincode)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Enter a 6-digit pincode that does not start with 0.',
      field: 'pincode',
    });
  }
}

async function describeTehsils(tehsilIds: unknown[]) {
  const tehsils = await Tehsil.find({ _id: { $in: tehsilIds } });
  const districts = await District.find({
    _id: { $in: tehsils.map((t) => t.districtId).filter(Boolean) },
  });
  const stateIdByDistrict = new Map(districts.map((d) => [id(d._id), id(d.stateId)]));
  return new Map(
    tehsils.map((t) => [
      id(t._id),
      {
        tehsilId: id(t._id),
        tehsilName: t.name,
        districtId: t.districtId ? id(t.districtId) : null,
        districtName: t.district,
        stateId: t.districtId ? (stateIdByDistrict.get(id(t.districtId)) ?? null) : null,
        stateName: t.state,
      },
    ]),
  );
}

/** A known pincode fills a form's location in; an unknown one returns null. */
export async function lookupPincode(pincode: string): Promise<PincodeLocationDto | null> {
  assertPincodeShape(pincode);
  const row = await Pincode.findOne({ pincode });
  if (!row) return null;
  const place = (await describeTehsils([row.tehsilId])).get(id(row.tehsilId));
  if (!place) return null;
  return { pincode, status: row.status, ...place };
}

export async function listPincodes(filter: {
  status?: 'verified' | 'unverified';
}): Promise<PincodeListItemDto[]> {
  const rows = await Pincode.find(filter.status ? { status: filter.status } : {})
    .sort({ status: -1, pincode: 1 })
    .limit(1000);
  const places = await describeTehsils(rows.map((r) => r.tehsilId));
  const people = await Employee.find(
    { _id: { $in: rows.flatMap((r) => [r.createdBy, r.verifiedBy]).filter(Boolean) } },
    { person: 1 },
  );
  const personName = new Map(people.map((p) => [id(p._id), p.person]));
  return rows.map((row) => ({
    pincode: row.pincode,
    status: row.status,
    ...(places.get(id(row.tehsilId)) ?? {
      tehsilId: id(row.tehsilId),
      tehsilName: '—',
      districtId: null,
      districtName: '—',
      stateId: null,
      stateName: '—',
    }),
    createdByName: row.createdBy ? (personName.get(id(row.createdBy)) ?? null) : null,
    verifiedByName: row.verifiedBy ? (personName.get(id(row.verifiedBy)) ?? null) : null,
    createdAt: row.createdAt as Date,
  }));
}

async function requireTehsil(tehsilId: string) {
  assertValidObjectId(tehsilId, 'tehsilId');
  const tehsil = await Tehsil.findById(tehsilId);
  if (!tehsil) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick a tehsil from the list.',
      field: 'tehsilId',
    });
  }
  return tehsil;
}

/** Admin — correct an unverified pincode's tehsil and/or mark it verified. */
export async function updatePincode(
  pincode: string,
  input: { tehsilId?: string; verify?: boolean },
  actor: MasterActor,
): Promise<PincodeLocationDto> {
  assertPincodeShape(pincode);
  const row = await Pincode.findOne({ pincode });
  if (!row) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pincode not found.' });
  const before = { tehsilId: id(row.tehsilId), status: row.status };
  if (input.tehsilId) row.tehsilId = (await requireTehsil(input.tehsilId))._id as Types.ObjectId;
  if (input.verify) {
    row.status = 'verified';
    row.verifiedBy = actor.employeeId as unknown as Types.ObjectId;
    row.verifiedAt = new Date();
  }
  await row.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'pincode',
    entityId: row._id as Types.ObjectId,
    field: input.verify ? 'verify' : 'edit',
    oldValue: before,
    newValue: { tehsilId: id(row.tehsilId), status: row.status },
    correlationId: actor.correlationId,
  });
  const place = (await describeTehsils([row.tehsilId])).get(id(row.tehsilId))!;
  return { pincode, status: row.status, ...place };
}

/**
 * The save half of the LocationBlock (used by the buyer and seller forms
 * from Phase 3). A pincode already in the master is left exactly as it is —
 * a staff member picking a different tehsil on one form never edits the
 * master. An unknown pincode is stored against the picked tehsil as
 * `unverified`, for an Admin to check on Manage › Pincodes. Pass the
 * surrounding transaction's session so it commits with the registration.
 */
export async function recordPincodeIfUnknown(
  input: { pincode: string; tehsilId: string },
  actor: MasterActor,
  session?: ClientSession,
): Promise<{ status: 'known' | 'created' }> {
  assertPincodeShape(input.pincode);
  const existing = await Pincode.findOne({ pincode: input.pincode }).session(session ?? null);
  if (existing) return { status: 'known' };
  const tehsil = await requireTehsil(input.tehsilId);
  const [row] = await Pincode.create(
    [
      {
        pincode: input.pincode,
        tehsilId: tehsil._id,
        status: 'unverified',
        createdBy: actor.employeeId,
      },
    ],
    { session },
  );
  await writeAuditLog(
    {
      actorId: actor.employeeId,
      actorType: 'staff',
      entity: 'pincode',
      entityId: row!._id as Types.ObjectId,
      field: 'create',
      newValue: { pincode: input.pincode, tehsilId: input.tehsilId, status: 'unverified' },
      correlationId: actor.correlationId,
    },
    session,
  );
  return { status: 'created' };
}
