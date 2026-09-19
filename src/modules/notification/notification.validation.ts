import { z } from 'zod';
import { NOTIFICATION_OUTCOME_CODES } from '../../models/NotificationLog.js';
import { NOTIFICATION_TEMPLATE_KEYS } from './notification.templates.js';

export const notificationLogQuerySchema = z
  .object({
    templateKey: z.enum(NOTIFICATION_TEMPLATE_KEYS).optional(),
    outcomeCode: z.enum(NOTIFICATION_OUTCOME_CODES).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type NotificationLogQuery = z.infer<typeof notificationLogQuerySchema>;
