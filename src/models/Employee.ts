import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-14 `employee`. TD-005 — staff sign in with email + password. CH §24.1 —
 * enforced password rules and lockout after repeated failures live here.
 * CH §24.3 — mfaSecret is set only for Controller/Admin/Founder holders.
 *
 * Creation: QR-028 is open. Interim (this session): the seed script
 * (scripts/seedAdmin.ts) creates the first Admin; every other employee is
 * created by POST /admin/employees, which requires an authenticated Admin.
 * There is no public registration route.
 */
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
  },
  { timestamps: true },
);

export type EmployeeDocument = InferSchemaType<typeof employeeSchema>;
export const Employee = model<EmployeeDocument>('Employee', employeeSchema, 'employee');
