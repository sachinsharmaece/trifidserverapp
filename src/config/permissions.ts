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
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// BR-260 — seven roles. Admin and Controller are distinct: Admin configures
// the system, Controller runs the trade. Purchase/Sales/Transport &
// Logistics/Accounts have no M1/M2 endpoints yet — their permission lists
// grow from M3 onward.
export const ROLE_SEED: Array<{ key: string; label: string; permissionKeys: PermissionKey[] }> = [
  { key: 'purchase', label: 'Purchase', permissionKeys: [] },
  { key: 'sales', label: 'Sales', permissionKeys: [] },
  { key: 'transport_logistics', label: 'Transport & Logistics', permissionKeys: [] },
  { key: 'accounts', label: 'Accounts', permissionKeys: [] },
  {
    key: 'controller',
    label: 'Controller',
    permissionKeys: [PERMISSIONS.CONFIG_READ, PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.FILE_READ],
  },
  {
    key: 'admin',
    label: 'Admin',
    permissionKeys: [
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.CONFIG_WRITE,
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_WRITE,
      PERMISSIONS.FILE_READ,
    ],
  },
  {
    key: 'founder',
    label: 'Founder',
    permissionKeys: [PERMISSIONS.CONFIG_READ, PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.FILE_READ],
  },
];

// CH §24.3 — MFA on Controller, Admin and Founder only.
export const MFA_REQUIRED_ROLE_KEYS = new Set(['controller', 'admin', 'founder']);
