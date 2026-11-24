/**
 * Default business settings (ARCH §B3.2 `settings`, values from the prototype and the SRS).
 * `db:seed` only ADDS missing keys: a value an admin has changed is never overwritten.
 */
export const SETTINGS_SEED = [
    // Time windows
    {
        key: 'PAYMENT_WINDOW_HOURS',
        value: 24,
        type: 'NUMBER',
        description: 'Hours a buyer has to pay after the sales order is raised.',
    },
    {
        key: 'SELLER_HOLD_HOURS',
        value: 24,
        type: 'NUMBER',
        description: 'Hours the seller holds stock for a confirmed order.',
    },
    {
        key: 'DELIVERY_WINDOW_DAYS',
        value: 7,
        type: 'NUMBER',
        description: 'Days after dispatch within which delivery is expected.',
    },
    {
        key: 'TRANSIT_OVERDUE_DAYS',
        value: 4,
        type: 'NUMBER',
        description: 'Days in transit before a shipment is flagged overdue.',
    },
    { key: 'ASK_LIFE_DAYS', value: 30, type: 'NUMBER', description: 'Days a buyer ask stays open.' },
    {
        key: 'LISTING_LIFE_DAYS',
        value: 45,
        type: 'NUMBER',
        description: 'Days a seller listing stays live.',
    },
    {
        key: 'B1_ARCHIVE_DAYS',
        value: 7,
        type: 'NUMBER',
        description: 'Days before an idle b1 (viewing) trade is archived.',
    },
    // Stage SLAs (hours)
    {
        key: 'SLA_S0_HOURS',
        value: 7,
        type: 'NUMBER',
        description: 'SLA for seller stage s0 (demand).',
    },
    {
        key: 'SLA_S1_HOURS',
        value: 12,
        type: 'NUMBER',
        description: 'SLA for seller stage s1 (confirmation).',
    },
    {
        key: 'SLA_B3_HOURS',
        value: 11,
        type: 'NUMBER',
        description: 'SLA for buyer stage b3 (pending seller).',
    },
    { key: 'SLA_S3_HOURS', value: 8, type: 'NUMBER', description: 'SLA for seller stage s3 (PO).' },
    {
        key: 'SLA_S4_HOURS',
        value: 24,
        type: 'NUMBER',
        description: 'SLA for seller stage s4 (billed).',
    },
    {
        key: 'SLA_S5_HOURS',
        value: 48,
        type: 'NUMBER',
        description: 'SLA for seller stage s5 (dispatched).',
    },
    {
        key: 'SLA_B11_HOURS',
        value: 48,
        type: 'NUMBER',
        description: 'SLA for buyer stage b11 (complaints).',
    },
    // Tolerances and rules
    {
        key: 'MARG_TOLERANCE_PAISE',
        value: 500,
        type: 'NUMBER',
        description: 'Allowed difference (paise) between the Marg bill and the order total.',
    },
    {
        key: 'RATE_DECREASE_CONFIRM_BP',
        value: 200,
        type: 'NUMBER',
        description: 'A listing rate drop bigger than this (basis points) needs confirmation.',
    },
    {
        key: 'SHELF_LIFE_FLOOR_MONTHS',
        value: 6,
        type: 'NUMBER',
        description: 'Minimum months of shelf life left for stock to be listed.',
    },
    {
        key: 'PART_PAYMENT_ALLOWED',
        value: true,
        type: 'BOOLEAN',
        description: 'Whether a buyer may pay an order in parts.',
    },
    // Seller payouts
    {
        key: 'PAYOUT_RUN_TIMES',
        value: ['13:00', '16:00', '19:00'],
        type: 'JSON',
        description: 'Daily seller payout run times (IST).',
    },
    {
        key: 'PAYOUT_RUN_WINDOW_ENFORCED',
        value: false,
        type: 'BOOLEAN',
        description: 'Only allow payout release at the run times.',
    },
    // Feature switches (phase 2 features, off until built and approved)
    {
        key: 'STAFF_HIERARCHY_ENABLED',
        value: false,
        type: 'BOOLEAN',
        description: 'LOCK-37 staff hierarchy.',
    },
    {
        key: 'DORMANCY_ENABLED',
        value: false,
        type: 'BOOLEAN',
        description: 'LOCK-34 dormancy and pool.',
    },
    {
        key: 'SKU_MARGIN_ENABLED',
        value: false,
        type: 'BOOLEAN',
        description: 'LOCK-39 per-SKU margin matrix.',
    },
    { key: 'PORTAL_ENABLED', value: false, type: 'BOOLEAN', description: 'Buyer/seller portal.' },
];
//# sourceMappingURL=settings.seed.js.map