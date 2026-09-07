import { Permission } from '../models/Permission.js';
import { Role } from '../models/Role.js';
import { PERMISSIONS, ROLE_SEED } from '../config/permissions.js';

/**
 * BR-260 — seven roles, seeded once at startup. Idempotent: safe to run on
 * every boot, upserts rather than duplicating.
 */
export async function seedRolesAndPermissions(): Promise<void> {
  for (const permissionKey of Object.values(PERMISSIONS)) {
    await Permission.findOneAndUpdate(
      { key: permissionKey },
      { $setOnInsert: { key: permissionKey, label: permissionKey } },
      { upsert: true },
    );
  }

  for (const role of ROLE_SEED) {
    await Role.findOneAndUpdate(
      { key: role.key },
      { $set: { label: role.label, permissionKeys: role.permissionKeys } },
      { upsert: true },
    );
  }
}
