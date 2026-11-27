import { SettingModel } from '../models/index.js';
import { settingKeyOf } from '../modules/settings/catalogue.js';

/**
 * A number from the `settings` collection (like TRANSIT_OVERDUE_DAYS), or `fallback` if it is missing or not a
 * number. Old key names (SLA_S0_HOURS…) read the reference key that replaced them (modules/settings/catalogue.ts).
 * The Settings screen saves values as text, as the reference does, so "24" counts as 24.
 */
export async function numberSetting(key: string, fallback: number): Promise<number> {
  const setting = await SettingModel.findOne({ key: settingKeyOf(key) });
  const value: unknown = setting?.value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

/** A setting's text, or `fallback`. */
export async function textSetting(key: string, fallback: string): Promise<string> {
  const setting = await SettingModel.findOne({ key: settingKeyOf(key) });
  const value: unknown = setting?.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
