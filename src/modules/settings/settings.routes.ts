import { Router } from 'express';
import { z } from 'zod';
import { SettingModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { forbidden } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { SETTING_DEF_BY_KEY, SETTING_DEFS } from './catalogue.js';

/**
 * The Settings screen (reference: app/api/masters/settings). Everyone signed in may read the general settings;
 * Admin, Controller and Founder may change them. The credit and reminder settings are read and changed by Admin and
 * Controller only (the Founder never receives them).
 *
 *   GET   /settings            { settings: [{ key, label, tab, value }] }
 *   PATCH /settings { key, value }  ->  { setting }
 */
export const settingsRouter: Router = Router();

const EDITORS = ['ADMIN', 'CONTROLLER', 'FOUNDER'];
const CREDIT_ROLES = ['ADMIN', 'CONTROLLER'];

settingsRouter.use('/settings', requireAuth);

settingsRouter.get('/settings', async (req, res) => {
  const role = currentUserOf(req).role;
  const stored = await SettingModel.find({ key: { $in: SETTING_DEFS.map((def) => def.key) } });
  const valueOf = new Map(stored.map((row) => [row.key, String(row.value)]));
  res.json({
    settings: SETTING_DEFS.filter(
      (def) => def.tab === 'general' || CREDIT_ROLES.includes(role),
    ).map((def) => ({
      key: def.key,
      label: def.label,
      tab: def.tab,
      value: valueOf.get(def.key) ?? def.default,
    })),
  });
});

const patchBody = z.object({
  key: z.string().refine((key) => SETTING_DEF_BY_KEY.has(key), 'Unknown setting'),
  value: z.string().trim().min(1, 'Value is required').max(200),
});

settingsRouter.patch('/settings', async (req, res) => {
  const body = patchBody.parse(req.body);
  const def = SETTING_DEF_BY_KEY.get(body.key)!;
  const me = currentUserOf(req);
  if (!(def.tab === 'general' ? EDITORS : CREDIT_ROLES).includes(me.role)) throw forbidden();

  // Saved as text, as the reference does (`numberSetting()` reads numbers out of it).
  const setting = await SettingModel.findOne({ key: body.key });
  const before = setting ? String(setting.value) : def.default;
  if (setting) {
    setting.set({ type: 'STRING', value: body.value, updatedBy: me.id });
    await setting.save();
  } else {
    await SettingModel.create({
      key: body.key,
      type: 'STRING',
      value: body.value,
      description: def.label.slice(0, 300),
      updatedBy: me.id,
    });
  }
  await writeAudit(req, {
    action: def.tab === 'general' ? 'setting.update' : 'setting.changed',
    entityType: 'Setting',
    entityId: body.key,
    before: { value: before },
    after: { value: body.value },
  });
  res.json({ setting: { key: body.key, value: body.value } });
});
