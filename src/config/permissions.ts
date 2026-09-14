/**
 * TD-007 — permissions are strings, `module:action`. This list grows with
 * each milestone as API_CONTRACT.md grows; only the permissions behind an
 * endpoint that exists today are listed here.
 */
export const PERMISSIONS = {
  CONFIG_READ: 'config:read',
  CONFIG_WRITE: 'config:write',
  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_WRITE: 'employee:write',
  FILE_READ: 'file:read',
  // M3 additions
  CATALOG_WRITE: 'catalog:write',
  TERRITORY_READ: 'territory:read',
  TERRITORY_WRITE: 'territory:write',
  ONBOARDING_READ: 'onboarding:read',
  ONBOARDING_APPROVE: 'onboarding:approve',
  BANK_DETAIL_READ: 'bank_detail:read',
  BANK_DETAIL_WRITE: 'bank_detail:write',
  BOOK_ASSIGN: 'book:assign',
  // M4 additions — BUSINESS_RULES.md §2–§4, §17.
  MARGIN_MATRIX_READ: 'margin_matrix:read',
  MARGIN_MATRIX_WRITE: 'margin_matrix:write',
  CHAIN_READ: 'chain:read',
  SO_CREATE: 'so:create',
  SO_REDUCE_QUANTITY: 'so:reduce_quantity',
  PO_CREATE: 'po:create',
  PO_EDIT: 'po:edit',
  RECEIPT_READ: 'receipt:read',
  RECEIPT_ALLOCATE: 'receipt:allocate',
  BANK_POST: 'bank:post',
  BANK_REPOST: 'bank:repost',
  PAYOUT_BUILD: 'payout:build',
  PAYOUT_RELEASE: 'payout:release',
  PAYOUT_READ: 'payout:read',
  MARG_KEY: 'marg:key',
  DAY_CLOSE_RUN: 'day_close:run',
  DOCK_INSPECT: 'dock:inspect',
  MOVEMENT_WRITE: 'movement:write',
  REGISTER_READ: 'register:read',
  // M5 additions — BUSINESS_RULES.md §7–§9.
  POOL_RESOLVE_SHORTFALL: 'pool:resolve_shortfall',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// BR-260 — seven roles. Admin and Controller are distinct: Admin configures
// the system, Controller runs the trade. Purchase/Sales/Transport &
// Logistics/Accounts had no M1/M2 endpoints; M3 gives Purchase, Sales and
// Accounts their first real permissions.
export const ROLE_SEED: Array<{ key: string; label: string; permissionKeys: PermissionKey[] }> = [
  {
    key: 'purchase',
    label: 'Purchase',
    permissionKeys: [
      PERMISSIONS.CATALOG_WRITE,
      PERMISSIONS.TERRITORY_READ,
      PERMISSIONS.TERRITORY_WRITE,
      PERMISSIONS.ONBOARDING_READ,
      PERMISSIONS.ONBOARDING_APPROVE,
      PERMISSIONS.MARGIN_MATRIX_READ,
      PERMISSIONS.CHAIN_READ,
      PERMISSIONS.PO_CREATE,
      PERMISSIONS.PO_EDIT,
      PERMISSIONS.REGISTER_READ,
      PERMISSIONS.POOL_RESOLVE_SHORTFALL,
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    permissionKeys: [
      PERMISSIONS.ONBOARDING_READ,
      PERMISSIONS.ONBOARDING_APPROVE,
      PERMISSIONS.BOOK_ASSIGN,
      PERMISSIONS.MARGIN_MATRIX_READ,
      PERMISSIONS.CHAIN_READ,
      PERMISSIONS.SO_CREATE,
      PERMISSIONS.SO_REDUCE_QUANTITY,
      PERMISSIONS.RECEIPT_READ,
      PERMISSIONS.RECEIPT_ALLOCATE,
      PERMISSIONS.REGISTER_READ,
    ],
  },
  {
    key: 'transport_logistics',
    label: 'Transport & Logistics',
    // Q9a — the dock operator. This role was seeded empty in M1/M2; M4 gives
    // it its first real permissions.
    permissionKeys: [PERMISSIONS.CHAIN_READ, PERMISSIONS.DOCK_INSPECT, PERMISSIONS.MOVEMENT_WRITE],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    permissionKeys: [
      PERMISSIONS.BANK_DETAIL_READ,
      PERMISSIONS.BANK_DETAIL_WRITE,
      PERMISSIONS.CHAIN_READ,
      PERMISSIONS.RECEIPT_READ,
      PERMISSIONS.BANK_POST,
      PERMISSIONS.PAYOUT_BUILD,
      PERMISSIONS.PAYOUT_READ,
      PERMISSIONS.MARG_KEY,
      PERMISSIONS.DAY_CLOSE_RUN,
      PERMISSIONS.REGISTER_READ,
    ],
  },
  {
    key: 'controller',
    label: 'Controller',
    permissionKeys: [
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.FILE_READ,
      PERMISSIONS.TERRITORY_READ,
      PERMISSIONS.ONBOARDING_READ,
      PERMISSIONS.BANK_DETAIL_READ,
      PERMISSIONS.MARGIN_MATRIX_READ,
      PERMISSIONS.CHAIN_READ,
      PERMISSIONS.RECEIPT_READ,
      PERMISSIONS.BANK_REPOST,
      PERMISSIONS.PAYOUT_READ,
      PERMISSIONS.PAYOUT_RELEASE,
      PERMISSIONS.REGISTER_READ,
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    // Super admin — every permission that exists, always, including ones
    // added by a later milestone. Admin is the one role the Charter treats
    // as "configures the system" without a narrower desk boundary (CH
    // §17.1), so an explicit per-permission list here would only ever be a
    // maintenance trap: someone adds a new PERMISSIONS key for a new desk
    // and forgets to also add it here, and Admin quietly loses access.
    permissionKeys: Object.values(PERMISSIONS),
  },
  {
    key: 'founder',
    label: 'Founder',
    permissionKeys: [
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.FILE_READ,
      PERMISSIONS.TERRITORY_READ,
      PERMISSIONS.ONBOARDING_READ,
      PERMISSIONS.BANK_DETAIL_READ,
      PERMISSIONS.MARGIN_MATRIX_READ,
      PERMISSIONS.CHAIN_READ,
      PERMISSIONS.PAYOUT_READ,
      PERMISSIONS.REGISTER_READ,
    ],
  },
];

// CH §24.3 — MFA on Controller, Admin and Founder only.
export const MFA_REQUIRED_ROLE_KEYS = new Set(['controller', 'admin', 'founder']);

/**
 * CH §18.2 — the Purchase desk's fixed lane board (Funnel B: the trade).
 * "Every joint and every leak is a lane" (§17.11). Read directly from the
 * Charter text present in this workspace — not a placeholder. Sales has no
 * equivalent lane list (§19: books, not lanes; DEC-S08 rejected a more
 * elaborate Sales funnel model as too complex), and no other desk defines
 * one either, so this is the entire lane board for now.
 */
export const LANE_SEED: Array<{ key: string; funnel: string; label: string }> = [
  { key: 'B1', funnel: 'purchase_trade', label: 'Demand raised — Supply wanted' },
  { key: 'B2', funnel: 'purchase_trade', label: 'Visible — Silent board' },
  { key: 'B3', funnel: 'purchase_trade', label: 'Quoted — Unconverted quote' },
  { key: 'B3a', funnel: 'purchase_trade', label: 'Quoted but short' },
  { key: 'B4', funnel: 'purchase_trade', label: 'Taken — Stalled pile' },
  { key: 'B5', funnel: 'purchase_trade', label: 'Confirmed — Missed cut-off' },
  { key: 'B6', funnel: 'purchase_trade', label: 'Dispatched — Band miss' },
  { key: 'B7', funnel: 'purchase_trade', label: 'Landed — Rejection' },
  { key: 'B8', funnel: 'purchase_trade', label: 'Accepted — Uncollected debit' },
];
