import { NotificationTemplate } from '../../models/NotificationTemplate.js';
import { logger } from '../../shared/logger.js';
import { getWhatsAppTransport } from './notification.transport.js';

export interface TemplatePollSummary {
  polled: boolean;
  checked: number;
  changed: number;
}

/**
 * BR-295 — hourly. "In production Meta can pause a template without asking",
 * so the status is read back from Meta and kept in step here. A template that
 * has moved to `paused` (or `rejected`) is what raises the worklist item — see
 * `getNotificationWorklist` in notification.service.ts, which reads this
 * collection directly, so the item exists exactly as long as the template
 * stays unusable and clears itself when Meta reports it approved again.
 *
 * The generic fallback stays approved and unused: nothing here, and nothing in
 * the drain, ever substitutes it for a paused template. That is a person's call.
 *
 * With no WhatsApp credentials configured (development, test) there is nothing
 * to poll: this logs that plainly and changes nothing, rather than pretending.
 */
export async function runTemplateStatusPoll(now: Date = new Date()): Promise<TemplatePollSummary> {
  const reported = await getWhatsAppTransport().fetchTemplateStatuses();
  if (reported === null) {
    logger.info({ msg: 'Template status poll skipped — WhatsApp not configured' });
    return { polled: false, checked: 0, changed: 0 };
  }

  let changed = 0;
  for (const item of reported) {
    const template = await NotificationTemplate.findOne({
      metaTemplateName: item.metaTemplateName,
      language: item.language,
    });
    if (!template) continue; // Not one of ours (someone else's template in the same account).

    const statusChanged = template.status !== item.status;
    template.lastPolledAt = now;
    if (statusChanged) {
      template.status = item.status;
      template.statusChangedAt = now;
      if (item.status === 'approved') template.approvedAt = now;
      changed += 1;
    }
    await template.save();
  }
  return { polled: true, checked: reported.length, changed };
}
