import { z } from 'zod';
import { Config } from '../../models/Config.js';
import { AppError } from '../../shared/errors.js';
/**
 * LOCK-34 §4.1 — the policy values, held in the admin `config` table under
 * `dormancy.*` keys (edited through PUT /admin/dormancy-policy, which writes
 * each change through the audited `updateConfig`: who, when, from, to).
 *
 * `billingThreshold` is stored in paise, the unit of every sales-order amount.
 */
export const SETTING_KEYS = {
    enabled: 'dormancy.enabled',
    goLiveDate: 'dormancy.goLiveDate',
    orderedDays: 'dormancy.orderedDays',
    billingThresholdPaise: 'dormancy.billingThreshold',
    reasonWindowDays: 'dormancy.reasonWindowDays',
    uncalledCap: 'dormancy.uncalledCap',
    firstCallWorkingHours: 'dormancy.firstCallWorkingHours',
    leadDays: 'dormancy.leadDays',
    unclaimedDays: 'dormancy.unclaimedDays',
    backlogPerWeek: 'dormancy.backlogPerWeek',
    seasons: 'dormancy.seasons',
};
export const DEFAULT_SETTINGS = {
    enabled: false,
    goLiveDate: null,
    orderedDays: 90,
    billingThresholdPaise: 10_000 * 100,
    reasonWindowDays: 7,
    uncalledCap: 50,
    firstCallWorkingHours: 4,
    leadDays: 60,
    unclaimedDays: 3,
    backlogPerWeek: 100,
    seasons: [
        { name: 'Kharif', fromMonth: 6, toMonth: 9 },
        { name: 'Rabi', fromMonth: 10, toMonth: 2 },
        { name: 'Zaid', fromMonth: 3, toMonth: 5 },
    ],
};
export async function getSettings() {
    const rows = await Config.find({ key: { $regex: '^dormancy\\.' } }).lean();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const settings = { ...DEFAULT_SETTINGS };
    for (const name of Object.keys(SETTING_KEYS)) {
        const value = byKey.get(SETTING_KEYS[name]);
        if (value !== undefined && value !== null)
            settings[name] = value;
    }
    // Clearing the date stores an empty string (a config value cannot be empty-less).
    if (!settings.goLiveDate)
        settings.goLiveDate = null;
    return settings;
}
/** The feature switch. Cheap enough to ask from the few existing code paths that need it. */
export async function isHoldingEnabled() {
    const row = await Config.findOne({ key: SETTING_KEYS.enabled }, { value: 1 }).lean();
    return row?.value === true;
}
export async function assertHoldingEnabled() {
    if (!(await isHoldingEnabled())) {
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Dormant policy is switched off.' });
    }
}
// ---------------------------------------------------------------------------
// Admin edit
// ---------------------------------------------------------------------------
const whole = (label, min, max) => z
    .number({ message: `Enter ${label} as a number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} can be at most ${max}.`);
export const policyUpdateSchema = z
    .object({
    enabled: z.boolean(),
    goLiveDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the go-live date.')
        .nullable(),
    orderedDays: whole('Days before a buyer who orders is released', 1, 3650),
    billingThresholdPaise: whole('The billing amount', 100, 100_000_000_00),
    reasonWindowDays: whole('Days to give a reason', 1, 60),
    uncalledCap: whole('The uncalled limit', 1, 1000),
    firstCallWorkingHours: whole('Working hours to the first call', 1, 48),
    leadDays: whole('Days before a lead is released', 1, 3650),
    unclaimedDays: whole('Days in the Pool before the Team Leader looks', 0, 60),
    backlogPerWeek: whole('Backlog parties opened per week', 1, 100_000),
    seasons: z
        .array(z.object({
        name: z.string().trim().min(1, 'Name the season.'),
        fromMonth: whole('The first month', 1, 12),
        toMonth: whole('The last month', 1, 12),
    }))
        .max(12),
})
    .partial()
    .strict();
