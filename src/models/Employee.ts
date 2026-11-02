import { Schema, model, type InferSchemaType } from 'mongoose';
import { EDUCATION_LEVELS, POSITIONS } from '../config/positions.js';

/**
 * ENT-14 `employee`. TD-005 — staff sign in with email + password. CH §24.1 —
 * enforced password rules and lockout after repeated failures live here.
 * CH §24.3 — mfaSecret is set only for Controller/Admin/Founder holders.
 *
 * Creation: QR-028 is open. Interim (this session): the seed script
 * (scripts/seedAdmin.ts) creates the first Admin; every other employee is
 * created by POST /admin/employees, which requires an authenticated Admin.
 * There is no public registration route.
 *
 * Phase 2 (DEC-059, DEC-061) — mobile, team positions and reporting lines,
 * "works for team(s)" for Accounts/Logistics, and the HR block. Every Phase 2
 * field is optional **on the model** so employees created before it keep
 * loading; the create/edit API requires them (admin.team.ts). PAN and
 * Aadhaar are stored only encrypted (PII_ENCRYPTION_KEY), with the last four
 * characters beside them for the masked display.
 */
const addressSchema = new Schema({ line: { type: String, required: true } }, { _id: false });

const hrSchema = new Schema(
  {
    dob: { type: Date, required: true },
    panEncrypted: { type: String, required: true },
    panLast4: { type: String, required: true },
    aadhaarEncrypted: { type: String, required: true },
    aadhaarLast4: { type: String, required: true },
    fatherName: { type: String, required: true },
    fatherMobile: { type: String, default: null },
    husbandName: { type: String, default: null },
    husbandMobile: { type: String, default: null },
    emergencyContact: {
      name: { type: String, required: true },
      relation: { type: String, required: true },
      mobile: { type: String, required: true },
    },
    permanentAddress: { type: addressSchema, required: true },
    currentAddress: { type: addressSchema, required: true },
    currentSameAsPermanent: { type: Boolean, required: true, default: false },
    education: {
      level: { type: String, enum: EDUCATION_LEVELS, default: null },
      other: { type: String, default: null },
    },
  },
  { _id: false },
);

const employeeSchema = new Schema(
  {
    person: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    desk: { type: String },
    roleIds: { type: [Schema.Types.ObjectId], ref: 'Role', required: true, default: [] },
    mfaSecret: { type: String, default: null },
    mfaEnabled: { type: Boolean, required: true, default: false },
    active: { type: Boolean, required: true, default: true },
    failedLoginAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },

    // Phase 2 ---------------------------------------------------------------
    mobile: { type: String, default: null },
    positions: { type: [String], enum: POSITIONS, default: [] },
    reportsToSalesLeaderId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    reportsToPurchaseLeaderId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    // Accounts / Logistics (DEC-060): the sales leaders whose teams this
    // person works for, or every team (an Accounts head).
    worksForTeamLeaderIds: { type: [Schema.Types.ObjectId], ref: 'Employee', default: [] },
    worksForAllTeams: { type: Boolean, required: true, default: false },
    hr: { type: hrSchema, default: null },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

// Unique among employees — partial, so employees created before Phase 2
// (no mobile yet) do not collide on null.
employeeSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } },
);
employeeSchema.index({ reportsToSalesLeaderId: 1 });
employeeSchema.index({ reportsToPurchaseLeaderId: 1 });

export type EmployeeDocument = InferSchemaType<typeof employeeSchema>;
export const Employee = model<EmployeeDocument>('Employee', employeeSchema, 'employee');
