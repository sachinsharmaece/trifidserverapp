import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './notification.controller.js';
import { notificationLogQuerySchema } from './notification.validation.js';

export const notificationRouter = Router();

// New — M8, BR-293. A read screen for debugging delivery; not a console.
notificationRouter.get(
  '/staff/notifications/log',
  authenticate,
  requirePermission(PERMISSIONS.NOTIFICATION_LOG_READ),
  validateQuery(notificationLogQuerySchema),
  controller.getNotificationLog,
);

// New — M8, BR-295 / BR-292. Paused templates and the four-hour staff queue.
notificationRouter.get(
  '/staff/notifications/worklist',
  authenticate,
  requirePermission(PERMISSIONS.NOTIFICATION_LOG_READ),
  controller.getNotificationWorklist,
);

// New — M8, BR-290. Meta's callbacks; authenticated by signature, not by login.
notificationRouter.get('/webhooks/whatsapp', controller.getWhatsAppWebhookHandshake);
notificationRouter.post('/webhooks/whatsapp', controller.postWhatsAppWebhook);
