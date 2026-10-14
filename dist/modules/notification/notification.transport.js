import { env, isTest } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
function isConfigured() {
    return (!isTest &&
        env.whatsappAccessToken !== 'replace-me' &&
        env.whatsappPhoneNumberId !== 'replace-me');
}
// Meta's own status vocabulary → ours. Anything unrecognised is treated as
// `pending`, never `approved`: an unknown state must not look sendable.
function mapMetaStatus(raw) {
    switch (raw.toUpperCase()) {
        case 'APPROVED':
            return 'approved';
        case 'PAUSED':
        case 'DISABLED':
            return 'paused';
        case 'REJECTED':
            return 'rejected';
        default:
            return 'pending';
    }
}
function graphUrl(path) {
    return `https://graph.facebook.com/${env.whatsappApiVersion}/${path}`;
}
const realWhatsAppTransport = {
    async send(request) {
        if (!isConfigured()) {
            return {
                outcome: 'not_configured',
                httpStatus: null,
                providerMessageId: null,
                providerErrorCode: null,
            };
        }
        try {
            const response = await fetch(graphUrl(`${env.whatsappPhoneNumberId}/messages`), {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.whatsappAccessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: request.toMobile,
                    type: 'template',
                    template: {
                        name: request.metaTemplateName,
                        language: { code: request.language },
                        components: [
                            {
                                type: 'body',
                                parameters: request.bodyParams.map((text) => ({ type: 'text', text })),
                            },
                        ],
                    },
                }),
            });
            const body = (await response.json().catch(() => ({})));
            if (response.ok) {
                return {
                    outcome: 'accepted',
                    httpStatus: response.status,
                    providerMessageId: body.messages?.[0]?.id ?? null,
                    providerErrorCode: null,
                };
            }
            return {
                outcome: 'api_error',
                httpStatus: response.status,
                providerMessageId: null,
                providerErrorCode: body.error?.code !== undefined ? String(body.error.code) : null,
            };
        }
        catch (error) {
            logger.warn({ msg: 'WhatsApp send failed before a response', error: String(error) });
            return {
                outcome: 'api_error',
                httpStatus: null,
                providerMessageId: null,
                providerErrorCode: null,
            };
        }
    },
    async fetchTemplateStatuses() {
        if (!isConfigured() || env.whatsappBusinessAccountId === 'replace-me')
            return null;
        const response = await fetch(graphUrl(`${env.whatsappBusinessAccountId}/message_templates?fields=name,language,status&limit=200`), { headers: { Authorization: `Bearer ${env.whatsappAccessToken}` } });
        if (!response.ok)
            throw new Error(`Meta template poll failed with HTTP ${response.status}.`);
        const body = (await response.json());
        const rows = [];
        for (const item of body.data ?? []) {
            // Meta's language codes look like `en`, `en_US`, `hi`; ours are the two-letter stem.
            const stem = item.language.slice(0, 2);
            if (stem !== 'en' && stem !== 'hi')
                continue;
            rows.push({
                metaTemplateName: item.name,
                language: stem,
                status: mapMetaStatus(item.status),
            });
        }
        return rows;
    },
};
let whatsAppTransport = realWhatsAppTransport;
export function getWhatsAppTransport() {
    return whatsAppTransport;
}
/** Test seam — pass `null` to restore the real transport. */
export function setWhatsAppTransport(transport) {
    whatsAppTransport = transport ?? realWhatsAppTransport;
}
const stubSmsSender = {
    async send(request) {
        logger.info({
            msg: 'SMS escalation step reached — stub, nothing sent (DLT registration pending, QR-023)',
            templateKey: request.templateKey,
        });
        return { outcome: 'stub_not_sent', providerErrorCode: null };
    },
};
let smsSender = stubSmsSender;
export function getSmsSender() {
    return smsSender;
}
/** Test seam — pass `null` to restore the stub. */
export function setSmsSender(sender) {
    smsSender = sender ?? stubSmsSender;
}
/** WhatsApp wants country code + national number, digits only. Indian mobiles are ten digits. */
export function toWhatsAppNumber(mobile) {
    const digits = mobile.replace(/\D/g, '');
    if (digits.length === 10)
        return `91${digits}`;
    if (digits.length === 12 && digits.startsWith('91'))
        return digits;
    return null;
}
