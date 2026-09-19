import type { ClientSession, Types } from 'mongoose';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { NotificationOutbox } from '../../models/NotificationOutbox.js';
import { NotificationLog } from '../../models/NotificationLog.js';
import { addDays } from '../../shared/clock.js';
import { TEMPLATE_PARAM_NAMES, type NotificationTemplateKey } from './notification.templates.js';

// BR-283 / CH §19.7 — one WhatsApp message per customer per week. A rolling
// seven days from the last message queued (the Charter says "per week" and does
// not say whether that is a calendar week — see QR-054).
export const WHATSAPP_CAP_WINDOW_DAYS = 7;

export type NotificationParams = Record<string, string | number>;

export interface EnqueueInput {
  counterpartyId: Types.ObjectId | string;
  templateKey: NotificationTemplateKey;
  params: NotificationParams;
  correlationId?: string;
}

export interface EnqueueResult {
  outboxId: string;
  suppressedByCap: boolean;
}

function assertParamsMatchTemplate(input: EnqueueInput): void {
  const expected = TEMPLATE_PARAM_NAMES[input.templateKey];
  for (const name of expected) {
    if (input.params[name] === undefined) {
      // A developer error, never a user error — fail loudly at the trigger
      // site rather than sending Meta a template with a blank placeholder.
      throw new Error(`Notification "${input.templateKey}" is missing parameter "${name}".`);
    }
  }
}

/**
 * BR-283 — claims this counterparty's weekly WhatsApp slot, atomically.
 *
 * A single conditional update on the counterparty document: it succeeds only
 * if no message was queued in the last seven days. Because it runs inside the
 * caller's transaction, (a) two concurrent triggers for one counterparty
 * cannot both win — MongoDB serialises them on this one document — and (b) a
 * rolled-back trigger gives the slot back, so a message that never happened
 * never uses up the week.
 */
async function claimWeeklyWhatsAppSlot(
  counterpartyId: Types.ObjectId | string,
  now: Date,
  session: ClientSession,
): Promise<{ claimed: boolean; language: 'en' | 'hi' | null }> {
  const windowStart = addDays(now, -WHATSAPP_CAP_WINDOW_DAYS);
  const claimed = await Counterparty.findOneAndUpdate(
    {
      _id: counterpartyId,
      $or: [{ lastWhatsAppQueuedAt: null }, { lastWhatsAppQueuedAt: { $lte: windowStart } }],
    },
    { $set: { lastWhatsAppQueuedAt: now } },
    { session, new: false },
  );
  if (claimed) return { claimed: true, language: claimed.preferredLanguage };

  const existing = await Counterparty.findById(counterpartyId).session(session);
  return { claimed: false, language: existing ? existing.preferredLanguage : null };
}

/**
 * TD-004 — the ONLY way a notification is queued, and it demands the caller's
 * transaction session: there is deliberately no session-less form. Call it from
 * inside the same `withTransaction` as the business write that triggers it, so
 * a crash or a rollback keeps the two together.
 *
 * BR-283 — the weekly cap is enforced here, in the write itself. A capped
 * message is still recorded (state `suppressed_cap`, with a log line) so it is
 * visible on the notification log and never silently vanishes, but it is never
 * sent. Calls are not capped — nothing here touches them.
 */
export async function enqueueNotification(
  input: EnqueueInput,
  session: ClientSession,
): Promise<EnqueueResult> {
  assertParamsMatchTemplate(input);
  const now = new Date();

  const slot = await claimWeeklyWhatsAppSlot(input.counterpartyId, now, session);
  if (slot.language === null) {
    throw new Error(`Notification target counterparty ${String(input.counterpartyId)} not found.`);
  }

  const [outbox] = await NotificationOutbox.create(
    [
      {
        counterpartyId: input.counterpartyId,
        templateKey: input.templateKey,
        params: input.params,
        language: slot.language,
        channel: 'whatsapp',
        state: slot.claimed ? 'queued' : 'suppressed_cap',
        scheduledFor: now,
        correlationId: input.correlationId ?? null,
      },
    ],
    { session, ordered: true },
  );
  if (!outbox) throw new Error('NotificationOutbox.create returned no document.');

  if (!slot.claimed) {
    await NotificationLog.create(
      [
        {
          outboxId: outbox._id,
          counterpartyId: input.counterpartyId,
          templateKey: input.templateKey,
          channel: 'whatsapp',
          sentAt: now,
          deliveryStatus: 'not_sent',
          outcomeCode: 'CAP_SUPPRESSED',
        },
      ],
      { session, ordered: true },
    );
  }

  return { outboxId: (outbox._id as Types.ObjectId).toString(), suppressedByCap: !slot.claimed };
}

/** A trigger that has a `Buyer` id in hand (not a counterparty id) uses these. */
export async function counterpartyIdForBuyer(
  buyerId: Types.ObjectId | string,
  session: ClientSession,
): Promise<Types.ObjectId> {
  const buyer = await Buyer.findById(buyerId).session(session);
  if (!buyer) throw new Error(`Buyer ${String(buyerId)} not found for a notification.`);
  return buyer.counterpartyId as Types.ObjectId;
}

export async function counterpartyIdForSeller(
  sellerId: Types.ObjectId | string,
  session: ClientSession,
): Promise<Types.ObjectId> {
  const seller = await Seller.findById(sellerId).session(session);
  if (!seller) throw new Error(`Seller ${String(sellerId)} not found for a notification.`);
  return seller.counterpartyId as Types.ObjectId;
}

/** Two-decimal rupees for a template placeholder. Money is integer paise everywhere else. */
export function paiseToRupeesText(paise: number): string {
  return (paise / 100).toFixed(2);
}
