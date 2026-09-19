import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-49 `notification_template`. BR-291 — seventeen templates, each with an
 * `en` and a `hi` row: 17 × 2 = 34 Meta approvals.
 *
 * `metaTemplateName` is a PLACEHOLDER until the real Meta approvals land
 * (a parallel, non-code task with a genuine lead time) — the seed writes names
 * like `trifid_order_confirmed_en_v1`. The poll job (BR-295) keeps `status` in
 * step with what Meta reports once the real names are configured.
 *
 * BR-295 — `generic_fallback` is seeded approved and is NEVER sent
 * automatically; only a person may choose to use it.
 */
export const NOTIFICATION_LANGUAGES = ['en', 'hi'] as const;
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number];

// CH §21.3/§21.4 — nearly all traffic is Utility. `marketing` exists only for the
// weekly rate broadcast (BR-294), which is not one of the seventeen templates.
export const TEMPLATE_CATEGORIES = ['utility', 'marketing'] as const;
export const TEMPLATE_STATUSES = ['approved', 'paused', 'rejected', 'pending'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

const notificationTemplateSchema = new Schema(
  {
    key: { type: String, required: true },
    category: { type: String, enum: TEMPLATE_CATEGORIES, required: true, default: 'utility' },
    metaTemplateName: { type: String, required: true },
    language: { type: String, enum: NOTIFICATION_LANGUAGES, required: true },
    approvedAt: { type: Date, default: null },
    status: { type: String, enum: TEMPLATE_STATUSES, required: true, default: 'pending' },
    lastPolledAt: { type: Date, default: null },
    // When `status` last changed — how long a paused template has been on the worklist.
    statusChangedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationTemplateSchema.index({ key: 1, language: 1 }, { unique: true });

export type NotificationTemplateDocument = InferSchemaType<typeof notificationTemplateSchema>;
export const NotificationTemplate = model<NotificationTemplateDocument>(
  'NotificationTemplate',
  notificationTemplateSchema,
  'notification_template',
);
