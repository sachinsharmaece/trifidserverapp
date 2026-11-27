/**
 * Every setting the Settings screen shows, in the reference's order, with its label and default (reference-copy
 * branch: lib/settings.ts and app/(admin)/settings/page.tsx of the reference). Values are kept as text, the way
 * the reference stores them; `numberSetting()` reads a number out of them.
 *
 * `credit: true` = the "Credit control" and "Payment reminders" tabs: only Admin and Controller see or change them
 * (the reference's L42.24, which leaves the Founder out on purpose).
 */
export interface SettingDef {
  key: string;
  label: string;
  default: string;
  tab: 'general' | 'credit' | 'reminders';
}

const general = (key: string, label: string, value: string): SettingDef => ({
  key,
  label,
  default: value,
  tab: 'general',
});

export const SETTING_DEFS: readonly SettingDef[] = [
  general('PAYMENT_WINDOW_HOURS', 'Buyer payment window (hours)', '24'),
  general('MARG_TOLERANCE_PAISE', 'Marg match tolerance (paise)', '500'),
  general('TRANSIT_OVERDUE_DAYS', 'Transit overdue (days)', '4'),
  general('DELIVERY_WINDOW_DAYS', 'Delivery window (days)', '7'),
  general('PAYOUT_RUN_TIMES', 'Payout run times (display only)', '13:00,16:00,19:00'),
  general('HOLD_HOURS', 'HOLD_HOURS', '24'),
  general('ASK_EXPIRES_DAYS', 'ASK_EXPIRES_DAYS', '30'),
  general('S0_QUOTE_DUE_HOURS', 'S0_QUOTE_DUE_HOURS', '7'),
  general('S1_CONFIRM_BY_HOURS', 'S1_CONFIRM_BY_HOURS', '12'),
  general('S3_PO_DUE_HOURS', 'S3_PO_DUE_HOURS', '8'),
  general('S4_DISPATCH_DUE_HOURS', 'S4_DISPATCH_DUE_HOURS', '24'),
  general('S5_DOCK_CHECK_DUE_HOURS', 'S5_DOCK_CHECK_DUE_HOURS', '48'),
  general('B3_SELLER_REPLY_DUE_HOURS', 'B3_SELLER_REPLY_DUE_HOURS', '11'),
  general('B4_SEND_TO_BUYER_BY_HOURS', 'B4_SEND_TO_BUYER_BY_HOURS', '2'),
  general('B8_BILL_DISPATCH_DUE_HOURS', 'B8_BILL_DISPATCH_DUE_HOURS', '4'),
  general('B11_RESOLVE_BY_HOURS', 'B11_RESOLVE_BY_HOURS', '48'),
  general('B1_ARCHIVE_DAYS', 'b1 (Viewing) archive after (days)', '7'),
  general(
    'STAFF_HIERARCHY_ENABLED',
    'Staff position hierarchy (LOCK-37) — "true" or "false"',
    'false',
  ),
  general('DORMANCY_ENABLED', 'Dormant policy (LOCK-34) — "true" or "false"', 'false'),
  general('DORMANCY_GO_LIVE_DATE', 'Dormant policy go-live date (YYYY-MM-DD)', ''),
  general('DORMANCY_ORDERED_DAYS', 'Dormant policy — ordered-party clock (days)', '90'),
  general(
    'DORMANCY_BILLING_THRESHOLD_PAISE',
    'Dormant policy — billing threshold (paise)',
    '1000000',
  ),
  general('DORMANCY_REASON_WINDOW_DAYS', 'Dormant policy — reason window (days)', '7'),
  general('DORMANCY_UNCALLED_CAP', 'Dormant policy — uncalled cap per caller', '50'),
  general(
    'DORMANCY_FIRST_CALL_WORKING_HOURS',
    'Dormant policy — first call due (working hours)',
    '4',
  ),
  general('DORMANCY_LEAD_DAYS', 'Dormant policy — lead/claim clock (days)', '60'),
  general('DORMANCY_UNCLAIMED_DAYS', 'Dormant policy — Team Leader list after (days)', '3'),
  general('DORMANCY_BACKLOG_PER_WEEK', 'Dormant policy — backlog windows opened per week', '100'),
  general(
    'DORMANCY_SEASONS',
    'Dormant policy — seasons (reporting only, display text)',
    'Kharif Jun-Sep, Rabi Oct-Feb, Zaid Mar-May',
  ),
  general('SKU_MATRIX_WARN_SHARE_PCT', 'SKU matrix: warn when this % of SKUs are overridden', '20'),
  general(
    'SKU_MATRIX_FOUNDER_MAY_APPROVE',
    'SKU matrix: Founder may also approve (true/false)',
    'false',
  ),
  general('SELL_LEAD_SLA_HOURS', 'Seller lead: hours to first action', '24'),
  general('DOCK_INSPECT_HOURS', 'Dock: hours from arrival to inspection', '24'),
  general('DOCK_SHELF_LIFE_FLOOR_MONTHS', 'Dock: shelf-life floor (months)', '6'),
  general('DOCK_RETURN_NOTE_DAYS', 'Dock: return-note clock (days)', '30'),
  ...(
    [
      [
        'CREDIT_EXEC_MAX_PAISE',
        'Executive request limit / TM approval line (₹ — above this only TM requests, Controller approves)',
        '10000000',
      ],
      ['CREDIT_MIN_BILLS', 'Paid cash bills before first credit (fewer → Controller)', '5'],
      ['CREDIT_FIRST_MULT', 'First limit up to × average bill (more → Controller)', '2'],
      ['CREDIT_INC_PCT', 'Max increase per request, % (more → Controller)', '50'],
      ['CREDIT_INC_DAYS', 'Min gap between increases, days (sooner → Controller)', '30'],
      ['CREDIT_REJ_WAIT_DAYS', 'Wait after a rejection, days (request blocked)', '15'],
      ['CREDIT_REF_MAX', 'Parties per reference (more → Controller)', '5'],
      [
        'CREDIT_EXEC_OVERDUE_PCT',
        'Executive overdue limit, % (above → his requests go to Controller)',
        '10',
      ],
      ['CREDIT_UNUSED_DAYS', 'Suspend if unused, days', '90'],
      [
        'CREDIT_CHEQUE_ABOVE_PAISE',
        'Show security cheque/agreement field above this (₹, optional)',
        '5000000',
      ],
    ] as const
  ).map(([key, label, value]): SettingDef => ({ key, label, default: value, tab: 'credit' })),
  ...(
    [
      ['REMINDER_BEFORE_DAYS', 'Before due date, days', '2'],
      ['REMINDER_ON_DUE', 'On due date — "true" or "false"', 'true'],
      ['REMINDER_EVERY_DAYS', 'After due, repeat every (days, until paid)', '3'],
    ] as const
  ).map(([key, label, value]): SettingDef => ({ key, label, default: value, tab: 'reminders' })),
];

/**
 * Keys our engine used before this branch, and the reference key that now holds the same value. Reading an old key
 * reads the new one, so the clocks and the Settings screen always agree.
 */
export const LEGACY_KEYS: Readonly<Record<string, string>> = {
  SELLER_HOLD_HOURS: 'HOLD_HOURS',
  ASK_LIFE_DAYS: 'ASK_EXPIRES_DAYS',
  SLA_S0_HOURS: 'S0_QUOTE_DUE_HOURS',
  SLA_S1_HOURS: 'S1_CONFIRM_BY_HOURS',
  SLA_S3_HOURS: 'S3_PO_DUE_HOURS',
  SLA_S4_HOURS: 'S4_DISPATCH_DUE_HOURS',
  SLA_B3_HOURS: 'B3_SELLER_REPLY_DUE_HOURS',
  SLA_B11_HOURS: 'B11_RESOLVE_BY_HOURS',
  INSPECTION_HOURS: 'DOCK_INSPECT_HOURS',
  RETURN_NOTE_DAYS: 'DOCK_RETURN_NOTE_DAYS',
  SHELF_LIFE_FLOOR_MONTHS: 'DOCK_SHELF_LIFE_FLOOR_MONTHS',
};

export const settingKeyOf = (key: string) => LEGACY_KEYS[key] ?? key;
export const SETTING_DEF_BY_KEY = new Map(SETTING_DEFS.map((def) => [def.key, def]));
