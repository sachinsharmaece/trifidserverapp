import { PERMISSIONS, type PermissionKey } from './permissions.js';

/**
 * Phase 2 — team positions (DEC-059). Roles stay the access control
 * (TD-007); a position says where someone sits in a team, and:
 *
 * - **adds its department's role** — any `SALES_*` adds `sales`, any
 *   `PURCHASE_*` adds `purchase` (done on save, so the role list on the
 *   record is what grants access);
 * - **grants a few leader permissions** of its own (POSITION_PERMISSIONS),
 *   read alongside the roles' permissions at sign-in.
 *
 * One person may hold several. **Every Sales Leader is also the Purchase
 * Executive of his own team**: holding SALES_LEADER always adds
 * PURCHASE_EXEC, which then needs a Purchase Leader to report to.
 * Admin, Founder and the other desks need no position.
 */
export const POSITIONS = [
  'SALES_LEADER',
  'PURCHASE_LEADER',
  'SALES_EXEC',
  'PURCHASE_EXEC',
] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_LABEL: Record<Position, string> = {
  SALES_LEADER: 'Sales Leader',
  PURCHASE_LEADER: 'Purchase Leader',
  SALES_EXEC: 'Sales Executive',
  PURCHASE_EXEC: 'Purchase Executive',
};

export const POSITION_ROLE: Record<Position, 'sales' | 'purchase'> = {
  SALES_LEADER: 'sales',
  SALES_EXEC: 'sales',
  PURCHASE_LEADER: 'purchase',
  PURCHASE_EXEC: 'purchase',
};

// Leaders add the location masters (BR-350). Later phases add the leader
// rights they introduce here (approve, assign within the team).
export const POSITION_PERMISSIONS: Record<Position, PermissionKey[]> = {
  SALES_LEADER: [PERMISSIONS.LOCATION_MASTER_WRITE, PERMISSIONS.BUYER_APPROVE],
  PURCHASE_LEADER: [PERMISSIONS.LOCATION_MASTER_WRITE, PERMISSIONS.SELLER_APPROVE],
  SALES_EXEC: [],
  PURCHASE_EXEC: [],
};

/** The positions actually held once the Sales-Leader rule is applied. */
export function withImpliedPositions(positions: readonly Position[]): Position[] {
  const held = new Set(positions);
  if (held.has('SALES_LEADER')) held.add('PURCHASE_EXEC');
  return POSITIONS.filter((p) => held.has(p));
}

export function permissionsForPositions(positions: readonly string[]): PermissionKey[] {
  return [
    ...new Set(
      positions.flatMap((p) =>
        p in POSITION_PERMISSIONS ? POSITION_PERMISSIONS[p as Position] : [],
      ),
    ),
  ];
}

export const EDUCATION_LEVELS = ['10th', '12th', 'graduate', 'post_graduate', 'other'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
