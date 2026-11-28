import { textSetting } from '../../db/settings.js';
import { UserModel } from '../../models/index.js';
import { POSITION_INFO, type StaffPosition } from '../../shared/enums.js';
import type { CurrentUser } from '../auth/currentUser.js';

/**
 * Staff hierarchy scope (reference LOCK-37, lib/staffHierarchy/scope.ts and lib/services/staffScope.ts).
 * With STAFF_HIERARCHY_ENABLED "true", the buyer and seller lists show a person only the parties owned
 * (`acquiredById`) by people he can see:
 *   - junior: only himself
 *   - senior: himself and the juniors who report to him (not the rest of the department)
 *   - top: everyone in his department, and staff with no manager
 * A party with no owner stays visible to everyone until someone owns it. People with no position (Controller,
 * Admin, Founder) are never narrowed, and with the switch off nothing changes.
 */

interface DeptStaff {
  id: string;
  reportsTo: string | null;
}

export function visibleStaffIds(
  viewer: { id: string; position: StaffPosition },
  deptStaff: DeptStaff[],
): Set<string> {
  const { tier } = POSITION_INFO[viewer.position];
  if (tier === 'top') return new Set(deptStaff.map((s) => s.id));
  const ids = new Set([viewer.id]);
  if (tier === 'senior') {
    for (const s of deptStaff) if (s.reportsTo === viewer.id) ids.add(s.id);
  }
  return ids;
}

/** The extra filter for a party list, or `{}` when nothing is narrowed. */
export async function ownerScopeFilter(viewer: CurrentUser): Promise<Record<string, unknown>> {
  if ((await textSetting('STAFF_HIERARCHY_ENABLED', 'false')) !== 'true') return {};
  const position = viewer.position as StaffPosition | null;
  if (!position || !(position in POSITION_INFO)) return {};
  const { department } = POSITION_INFO[position];
  const positioned = await UserModel.find({ position: { $exists: true, $ne: null } });
  const deptStaff = positioned
    .filter((u) => u.position && POSITION_INFO[u.position].department === department)
    .map((u) => ({ id: u.id, reportsTo: u.reportsToId ? String(u.reportsToId) : null }));
  const ids = [...visibleStaffIds({ id: viewer.id, position }, deptStaff)];
  return {
    $or: [
      { acquiredById: { $exists: false } },
      { acquiredById: null },
      { acquiredById: { $in: ids } },
    ],
  };
}
