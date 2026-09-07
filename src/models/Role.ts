import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-16 `role`. BR-260 — seven roles: Purchase, Sales, Transport & Logistics,
 * Accounts, Controller, Admin, Founder. Seeded once at startup (see
 * db/seedRoles.ts); a role-editing UI is not part of this session.
 */
const roleSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    permissionKeys: { type: [String], required: true, default: [] },
  },
  { timestamps: true },
);

export type RoleDocument = InferSchemaType<typeof roleSchema>;
export const Role = model<RoleDocument>('Role', roleSchema, 'role');
