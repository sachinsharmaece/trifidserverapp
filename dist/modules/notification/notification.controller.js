import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import * as notificationService from './notification.service.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getNotificationLog(req, res) {
    const query = req.validatedQuery;
    ok(res, req, await notificationService.listNotificationLog(query));
}
export async function getNotificationWorklist(req, res) {
    ok(res, req, await notificationService.getNotificationWorklist());
}
// ---------------------------------------------------------------------------
// Meta's webhook. Not behind `authenticate` — Meta is not a logged-in user —
// so the signature IS the authentication. With no app secret configured every
// callback is refused: an unconfigured server never trusts an unsigned body.
// ---------------------------------------------------------------------------
function signatureIsValid(rawBody, header) {
    if (!rawBody || !header || env.whatsappAppSecret === 'replace-me')
        return false;
    const expected = `sha256=${createHmac('sha256', env.whatsappAppSecret).update(rawBody).digest('hex')}`;
    const received = Buffer.from(header);
    const wanted = Buffer.from(expected);
    return received.length === wanted.length && timingSafeEqual(received, wanted);
}
/** Meta's one-time handshake when the webhook URL is registered. */
export function getWhatsAppWebhookHandshake(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' &&
        env.whatsappVerifyToken !== 'replace-me' &&
        token === env.whatsappVerifyToken &&
        typeof challenge === 'string') {
        res.status(200).send(challenge);
        return;
    }
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Webhook verification failed.' });
}
export async function postWhatsAppWebhook(req, res) {
    if (!signatureIsValid(req.rawBody, req.header('x-hub-signature-256'))) {
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Invalid webhook signature.' });
    }
    for (const update of notificationService.extractStatusUpdates(req.body)) {
        await notificationService.recordDeliveryStatus(update);
    }
    // Meta only needs a 200; a body is ignored.
    res.status(200).json({ received: true });
}
