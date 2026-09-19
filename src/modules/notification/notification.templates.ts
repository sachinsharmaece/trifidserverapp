import {
  NotificationTemplate,
  NOTIFICATION_LANGUAGES,
  type NotificationLanguage,
} from '../../models/NotificationTemplate.js';

/**
 * BR-291 / CH §21.8 — the seventeen templates, in the Charter's own order.
 * Each entry lists the named placeholders its Meta template carries. A
 * template body is written and approved on Meta's side; this file only knows
 * the key, who it goes to, and which named values the sender must supply.
 */
export const NOTIFICATION_TEMPLATE_KEYS = [
  'registration_invite',
  'rate_ready',
  'order_confirmed',
  'payment_due',
  'pool_75',
  'pool_triggered',
  'seller_requoted',
  'dispatched',
  'delivery_window',
  'short_dispatch',
  'refund_released',
  'lifeline_granted',
  'head_start_open',
  'po_released',
  'inspection_outcome',
  'listing_dropping',
  'generic_fallback',
] as const;
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

export const TEMPLATE_PARAM_NAMES: Record<NotificationTemplateKey, readonly string[]> = {
  registration_invite: ['outcome'], //                  'approved' | 'rejected'
  rate_ready: ['askId'],
  order_confirmed: ['soNo'],
  payment_due: ['soNo', 'amountRupees', 'payBy'],
  pool_75: ['poolId'],
  pool_triggered: ['soNo', 'payBy'],
  seller_requoted: ['pileId'],
  dispatched: ['soNo'],
  delivery_window: ['soNo', 'windowEndsOn'],
  short_dispatch: ['soNo', 'boxesShipped', 'refundRupees'],
  refund_released: ['amountRupees'],
  lifeline_granted: ['extensionHours'],
  head_start_open: ['askId'],
  po_released: ['poNo'],
  inspection_outcome: ['poNo', 'outcome'], //           'accepted' | 'part_rejected' | 'whole_lot_rejected'
  listing_dropping: ['listingId', 'dropsOn'],
  generic_fallback: [], //                               "no specifics, just the link"
};

export function placeholderMetaTemplateName(
  key: NotificationTemplateKey,
  language: NotificationLanguage,
): string {
  return `trifid_${key}_${language}_v1`;
}

/**
 * Idempotent — safe on every boot. Seeds 17 × 2 = 34 rows.
 *
 * `$setOnInsert` only: once a real Meta name or a real approval status has been
 * written (by hand, or by the BR-295 poll), a restart never overwrites it with
 * the placeholder again.
 *
 * Seeded `approved` so the outbox can run end to end in development, and because
 * BR-295 requires `generic_fallback` to sit approved and unused. **In production
 * these are not real approvals** — the placeholder names will not match anything
 * in Meta's account until the parallel approvals task is done.
 */
export async function seedNotificationTemplates(): Promise<void> {
  const seededAt = new Date();
  for (const key of NOTIFICATION_TEMPLATE_KEYS) {
    for (const language of NOTIFICATION_LANGUAGES) {
      await NotificationTemplate.updateOne(
        { key, language },
        {
          $setOnInsert: {
            key,
            language,
            category: 'utility',
            metaTemplateName: placeholderMetaTemplateName(key, language),
            status: 'approved',
            approvedAt: seededAt,
          },
        },
        { upsert: true },
      );
    }
  }
}
