import { env, isTest } from '../../config/env.js';
import type { NotificationLanguage, TemplateStatus } from '../../models/NotificationTemplate.js';
import { logger } from '../../shared/logger.js';

/**
 * BR-290 — direct integration on Meta's WhatsApp Cloud API, no BSP. A worker
 * calling an HTTPS endpoint is the whole integration (CH §21.1).
 *
 * Everything the drain and the poll job need from the outside world goes
 * through the two small interfaces below, so tests can swap in a recording
 * double and nothing in the test suite ever touches the network.
 */

export interface WhatsAppSendRequest {
  toMobile: string;
  metaTemplateName: string;
  language: NotificationLanguage;
  bodyParams: string[];
}

export interface WhatsAppSendResult {
  outcome: 'accepted' | 'api_error' | 'not_configured';
  httpStatus: number | null;
  providerMessageId: string | null;
  providerErrorCode: string | null;
}

export interface MetaTemplateStatus {
  metaTemplateName: string;
  language: NotificationLanguage;
  status: TemplateStatus;
}

export interface WhatsAppTransport {
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
  /** BR-295 — every template's current status, as Meta reports it. `null` = cannot poll (not configured). */
  fetchTemplateStatuses(): Promise<MetaTemplateStatus[] | null>;
}

function isConfigured(): boolean {
  return (
    !isTest &&
    env.whatsappAccessToken !== 'replace-me' &&
    env.whatsappPhoneNumberId !== 'replace-me'
  );
}

// Meta's own status vocabulary → ours. Anything unrecognised is treated as
// `pending`, never `approved`: an unknown state must not look sendable.
function mapMetaStatus(raw: string): TemplateStatus {
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

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.whatsappApiVersion}/${path}`;
}

const realWhatsAppTransport: WhatsAppTransport = {
  async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
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
      const body = (await response.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number };
      };
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
    } catch (error: unknown) {
      logger.warn({ msg: 'WhatsApp send failed before a response', error: String(error) });
      return {
        outcome: 'api_error',
        httpStatus: null,
        providerMessageId: null,
        providerErrorCode: null,
      };
    }
  },

  async fetchTemplateStatuses(): Promise<MetaTemplateStatus[] | null> {
    if (!isConfigured() || env.whatsappBusinessAccountId === 'replace-me') return null;
    const response = await fetch(
      graphUrl(
        `${env.whatsappBusinessAccountId}/message_templates?fields=name,language,status&limit=200`,
      ),
      { headers: { Authorization: `Bearer ${env.whatsappAccessToken}` } },
    );
    if (!response.ok) throw new Error(`Meta template poll failed with HTTP ${response.status}.`);
    const body = (await response.json()) as {
      data?: Array<{ name: string; language: string; status: string }>;
    };
    const rows: MetaTemplateStatus[] = [];
    for (const item of body.data ?? []) {
      // Meta's language codes look like `en`, `en_US`, `hi`; ours are the two-letter stem.
      const stem = item.language.slice(0, 2);
      if (stem !== 'en' && stem !== 'hi') continue;
      rows.push({
        metaTemplateName: item.name,
        language: stem,
        status: mapMetaStatus(item.status),
      });
    }
    return rows;
  },
};

let whatsAppTransport: WhatsAppTransport = realWhatsAppTransport;

export function getWhatsAppTransport(): WhatsAppTransport {
  return whatsAppTransport;
}

/** Test seam — pass `null` to restore the real transport. */
export function setWhatsAppTransport(transport: WhatsAppTransport | null): void {
  whatsAppTransport = transport ?? realWhatsAppTransport;
}

// ---------------------------------------------------------------------------
// SMS — BR-292's second rung.
//
// QR-023 confirmed SMS ships, but TRAI DLT registration is a separate non-code
// task with a lead time. So this is the INTERFACE the escalation ladder sends
// through, with a stub behind it that sends nothing and says so plainly. When
// DLT completes, only `realSmsSender` below changes — the ladder does not.
// ---------------------------------------------------------------------------

export interface SmsSendRequest {
  toMobile: string;
  templateKey: string;
  params: Record<string, string | number>;
}

export interface SmsSendResult {
  outcome: 'stub_not_sent' | 'accepted' | 'api_error';
  providerErrorCode: string | null;
}

export interface SmsSender {
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

const stubSmsSender: SmsSender = {
  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    logger.info({
      msg: 'SMS escalation step reached — stub, nothing sent (DLT registration pending, QR-023)',
      templateKey: request.templateKey,
    });
    return { outcome: 'stub_not_sent', providerErrorCode: null };
  },
};

let smsSender: SmsSender = stubSmsSender;

export function getSmsSender(): SmsSender {
  return smsSender;
}

/** Test seam — pass `null` to restore the stub. */
export function setSmsSender(sender: SmsSender | null): void {
  smsSender = sender ?? stubSmsSender;
}

/** WhatsApp wants country code + national number, digits only. Indian mobiles are ten digits. */
export function toWhatsAppNumber(mobile: string): string | null {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}
