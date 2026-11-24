import { SettingModel } from '../models/index.js';
/** A number from the `settings` collection (like LISTING_LIFE_DAYS), or `fallback` if it is missing or not a number. */
export async function numberSetting(key, fallback) {
    const setting = await SettingModel.findOne({ key });
    return typeof setting?.value === 'number' ? setting.value : fallback;
}
//# sourceMappingURL=settings.js.map