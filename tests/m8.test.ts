import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { withTransaction } from '../src/db/transaction.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { Complaint } from '../src/models/Complaint.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Inspection } from '../src/models/Inspection.js';
import { Listing } from '../src/models/Listing.js';
import { Movement } from '../src/models/Movement.js';
import { NonOrderReason } from '../src/models/NonOrderReason.js';
import { NotificationLog } from '../src/models/NotificationLog.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { NotificationTemplate } from '../src/models/NotificationTemplate.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Po } from '../src/models/Po.js';
import { Pool } from '../src/models/Pool.js';
import { Quote } from '../src/models/Quote.js';
import { Refund } from '../src/models/Refund.js';
import { Seller } from '../src/models/Seller.js';
import { SellerDebit } from '../src/models/SellerDebit.js';
import { So } from '../src/models/So.js';
import { addDays, addHours, addMinutes, istDateKey } from '../src/shared/clock.js';
import { createSoInSession } from '../src/modules/chain/chain.service.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import * as poolService from '../src/modules/pool/pool.service.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import * as controllerService from '../src/modules/controller/controller.service.js';
import { runHeadStartOpen } from '../src/modules/demand/headStartOpen.job.js';
import { runListingDropping } from '../src/modules/listing/listingDropping.job.js';
import { getFunnelReport } from '../src/modules/desk/purchase/purchase.funnel.js';
import { enqueueNotification } from '../src/modules/notification/notification.outbox.js';
import { runOutboxDrain } from '../src/modules/notification/notification.drain.js';
import { runTemplateStatusPoll } from '../src/modules/notification/notification.poll.js';
import { NOTIFICATION_TEMPLATE_KEYS } from '../src/modules/notification/notification.templates.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';
import {
  createListingViaApi,
  createLocationFor,
  installFakeTransports,
  newBuyer,
  newSeller,
  outboxRows,
  productIdForSku,
  resetOutbox,
  restoreRealTransports,
  seedTradeFixture,
  tokenFor,
} from './m8helpers.js';

const app = createApp();

/**
 * Some tests fabricate documents directly (random ids, no real parties behind them). The test
 * database is shared across files, so every fabricated document is deleted after its test —
 * otherwise a fake released PO or a fake closed order would leak into other suites (the bulk
 * lifeline walks every released PO; day close walks every closed order).
 */
const fabricated: Array<{ deleteOne: () => Promise<unknown> }> = [];

function tracked<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== 'create' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(
          target,
          args,
        );
        for (const doc of Array.isArray(result) ? result : [result]) {
          fabricated.push(doc as { deleteOne: () => Promise<unknown> });
        }
        return result;
      };
    },
  });
}

const FabAsk = tracked(Ask);
const FabListing = tracked(Listing);
const FabInspection = tracked(Inspection);
const FabNonOrderReason = tracked(NonOrderReason);
const FabQuote = tracked(Quote);
const FabPo = tracked(Po);
const FabMovement = tracked(Movement);
const FabPile = tracked(Pile);
const FabPileRequest = tracked(PileRequest);
const FabSellerDebit = tracked(SellerDebit);
const FabComplaint = tracked(Complaint);
const FabSo = tracked(So);

function idemKey(): string {
  return `m8-${Date.now()}-${Math.random()}`;
}

afterEach(async () => {
  restoreRealTransports();
  for (const doc of fabricated.splice(0)) await doc.deleteOne();
});

async function mobileOf(counterpartyId: string): Promise<string> {
  const counterparty = await Counterparty.findById(counterpartyId);
  return counterparty!.mobile;
}

async function enqueueOne(
  counterpartyId: string,
  templateKey: 'order_confirmed' | 'refund_released' | 'pool_75' = 'order_confirmed',
) {
  return withTransaction((session) =>
    enqueueNotification(
      {
        counterpartyId,
        templateKey,
        params:
          templateKey === 'order_confirmed'
            ? { soNo: 'SO-T' }
            : templateKey === 'refund_released'
              ? { amountRupees: '1.00' }
              : { poolId: 'P' },
      },
      session,
    ),
  );
}

// ---------------------------------------------------------------------------
// Step 0b timing — BR-122 / BR-231. Saturday 2026-09-19 is a real Saturday.
// IST is UTC+05:30, so 17:00 IST is 11:30Z.
// ---------------------------------------------------------------------------

describe('BR-231 — the head start counts 09:30–19:00 IST, Monday to Saturday, and nothing else', () => {
  it('a Saturday-evening ask does not open until Monday, 4 working hours after Monday 09:30 less what Saturday used', () => {
    const saturday1700Ist = new Date('2026-09-19T11:30:00Z');
    // 2h left on Saturday (to 19:00), Sunday skipped, 2h more from Monday 09:30 → Monday 11:30 IST.
    expect(demandService.computeVisibleToAllAt(saturday1700Ist, true).toISOString()).toBe(
      '2026-09-21T06:00:00.000Z',
    );
  });

  it('a Sunday-noon ask starts counting on Monday 09:30 → 13:30 IST', () => {
    const sunday1200Ist = new Date('2026-09-20T06:30:00Z');
    expect(demandService.computeVisibleToAllAt(sunday1200Ist, true).toISOString()).toBe(
      '2026-09-21T08:00:00.000Z',
    );
  });

  it('a Friday-evening ask carries its remainder to Saturday morning (Saturday IS a working day)', () => {
    const friday1800Ist = new Date('2026-09-18T12:30:00Z');
    // 1h left on Friday, then 3h from Saturday 09:30 → Saturday 12:30 IST.
    expect(demandService.computeVisibleToAllAt(friday1800Ist, true).toISOString()).toBe(
      '2026-09-19T07:00:00.000Z',
    );
  });

  it('an ask before opening time waits for 09:30, and no head start seller means immediate', () => {
    const monday0800Ist = new Date('2026-09-21T02:30:00Z');
    expect(demandService.computeVisibleToAllAt(monday0800Ist, true).toISOString()).toBe(
      '2026-09-21T08:00:00.000Z',
    );
    expect(demandService.computeVisibleToAllAt(monday0800Ist, false).toISOString()).toBe(
      monday0800Ist.toISOString(),
    );
  });
});

describe('head_start_open — the 5-minute job opens an ask only after 4 WORKING hours have elapsed', () => {
  it('does not fire at 4 calendar hours (Saturday 21:00), across Sunday, or at Monday 11:29 — fires at Monday 11:30', async () => {
    installFakeTransports();
    const buyer = await newBuyer(app);
    const trusted = await newSeller(app);
    await Seller.updateOne({ _id: trusted.docId }, { $set: { trustTier: 'Trusted' } });

    const raised = new Date('2026-09-19T11:30:00Z'); // Saturday 17:00 IST.
    const ask = await FabAsk.create({
      buyerId: buyer.docId,
      skuId: null,
      productId: new Types.ObjectId(),
      allPacks: true,
      qty: 3,
      conditionRequirement: { expiryBand: 'over12' },
      visibleToAllAt: demandService.computeVisibleToAllAt(raised, true),
      ttlAt: new Date('2026-12-31T00:00:00Z'),
      state: 'open',
    });
    const askId = String(ask._id);
    const opened = async () => (await Ask.findById(askId))!.headStartOpenedAt;

    await runHeadStartOpen(new Date('2026-09-19T15:30:00Z')); // Saturday 21:00 IST — 4 calendar hours on.
    expect(await opened()).toBeNull();

    await runHeadStartOpen(new Date('2026-09-20T06:30:00Z')); // Sunday noon.
    expect(await opened()).toBeNull();

    await runHeadStartOpen(new Date('2026-09-21T05:59:00Z')); // Monday 11:29 IST.
    expect(await opened()).toBeNull();
    expect(await NotificationOutbox.countDocuments({ 'params.askId': askId })).toBe(0);

    const atOpen = new Date('2026-09-21T06:00:00Z'); // Monday 11:30 IST.
    await runHeadStartOpen(atOpen);
    expect((await opened())!.toISOString()).toBe(atOpen.toISOString());

    // The Trusted seller who had the head start is sent `head_start_open` for this ask.
    const rows = await NotificationOutbox.find({
      counterpartyId: trusted.counterpartyId,
      templateKey: 'head_start_open',
      'params.askId': askId,
    });
    expect(rows).toHaveLength(1);

    // Running it again finds nothing more to do for this ask (claimed once).
    await runHeadStartOpen(addMinutes(atOpen, 5));
    expect(
      await NotificationOutbox.countDocuments({
        'params.askId': askId,
        templateKey: 'head_start_open',
        counterpartyId: trusted.counterpartyId,
      }),
    ).toBe(1);
  }, 60000);
});

describe('listing_dropping — fires once per listing, not once per day inside the 7-day window', () => {
  it('reminds a listing 5 days from its drop exactly once across several daily runs; ignores ones far out or already past', async () => {
    const seller = await newSeller(app);
    const now = new Date();
    const make = (expiresAt: Date) =>
      FabListing.create({
        productId: new Types.ObjectId(),
        sellerId: seller.docId,
        origin: 'seller_initiated',
        scopeType: 'my_area',
        state: 'live',
        expiresAt,
      });
    const near = await make(addDays(now, 5));
    const far = await make(addDays(now, 20));
    const past = await make(addDays(now, -1));

    const remindersFor = (listingId: unknown) =>
      NotificationOutbox.countDocuments({
        counterpartyId: seller.counterpartyId,
        templateKey: 'listing_dropping',
        'params.listingId': String(listingId),
      });

    await runListingDropping(now);
    await runListingDropping(addDays(now, 1));
    await runListingDropping(addDays(now, 2));
    await runListingDropping(addDays(now, 3));

    expect(await remindersFor(near._id)).toBe(1); // Once — not four times.
    expect((await Listing.findById(near._id))!.dropReminderSentAt).not.toBeNull();
    expect(await remindersFor(far._id)).toBe(0); // 20 days out at first; by day 3 it is still 17 out.
    expect(await remindersFor(past._id)).toBe(0); // Already dropped — a reminder is about what is ahead.
  }, 60000);
});

// ---------------------------------------------------------------------------
// The seventeen templates, the outbox transaction, and the weekly cap
// ---------------------------------------------------------------------------

describe('ENT-49 — seventeen templates, thirty-four rows, the generic fallback approved and unused', () => {
  it('seeds every BR-291 template in both languages', async () => {
    expect(NOTIFICATION_TEMPLATE_KEYS).toHaveLength(17);
    for (const key of NOTIFICATION_TEMPLATE_KEYS) {
      for (const language of ['en', 'hi']) {
        const row = await NotificationTemplate.findOne({ key, language });
        expect(row, `${key}/${language}`).not.toBeNull();
        expect(row!.metaTemplateName).toBe(`trifid_${key}_${language}_v1`);
      }
    }
    expect(
      await NotificationTemplate.countDocuments({ key: { $in: [...NOTIFICATION_TEMPLATE_KEYS] } }),
    ).toBe(34);
    const fallback = await NotificationTemplate.findOne({
      key: 'generic_fallback',
      language: 'en',
    });
    expect(fallback!.status).toBe('approved');
  });
});

describe('TD-004 — the outbox row is written INSIDE the business transaction', () => {
  it('a forced rollback of the trigger rolls the outbox row back with it — and gives the weekly slot back', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const buyerDocId = await createApprovedBuyer(app, sales.token);
    const sellerDocId = await createApprovedSeller(app, purchase.token);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);
    const buyer = (await Buyer.findById(buyerDocId))!;
    const cpId = String(buyer.counterpartyId);
    await resetOutbox(cpId);

    await expect(
      withTransaction(async (session) => {
        await createSoInSession(
          {
            buyerId: buyerDocId,
            sellerId: sellerDocId,
            skuId,
            boxes: 5,
            sellerNetPaise: 40000,
            placeOfSupply: 'intra_state',
          },
          { employeeId: admin.employeeId, correlationId: 'rollback-test' },
          session,
        );
        // Inside the transaction the outbox row exists...
        expect(
          await NotificationOutbox.countDocuments({ counterpartyId: cpId }).session(session),
        ).toBe(1);
        throw new Error('forced rollback after the trigger');
      }),
    ).rejects.toThrow('forced rollback');

    // ...and afterwards neither the SO, nor its outbox row, nor the used-up slot exists.
    expect(await So.countDocuments({ buyerId: buyerDocId })).toBe(0);
    expect(await NotificationOutbox.countDocuments({ counterpartyId: cpId })).toBe(0);
    expect((await Counterparty.findById(cpId))!.lastWhatsAppQueuedAt).toBeNull();
  }, 60000);

  it('a committed trigger leaves exactly one queued payment_due beside its SO', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const buyerDocId = await createApprovedBuyer(app, sales.token);
    const sellerDocId = await createApprovedSeller(app, purchase.token);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);
    const cpId = String((await Buyer.findById(buyerDocId))!.counterpartyId);
    await resetOutbox(cpId);

    const res = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        buyerId: buyerDocId,
        sellerId: sellerDocId,
        skuId,
        boxes: 5,
        sellerNetPaise: 40000,
        placeOfSupply: 'intra_state',
      });
    expect(res.status).toBe(201);

    const rows = await outboxRows(cpId, 'payment_due');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('queued');
    expect((rows[0]!.params as { soNo: string }).soNo).toBe(res.body.data.soNo);
  }, 60000);
});

describe('BR-283 — one WhatsApp message per customer per week, enforced in the write', () => {
  it('blocks a second send inside the window, records it, and sends only the first', async () => {
    const { sent } = installFakeTransports();
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);

    const first = await enqueueOne(buyer.counterpartyId, 'order_confirmed');
    const second = await enqueueOne(buyer.counterpartyId, 'refund_released');
    expect(first.suppressedByCap).toBe(false);
    expect(second.suppressedByCap).toBe(true);

    const rows = await outboxRows(buyer.counterpartyId);
    expect(rows.map((r) => r.state)).toEqual(['queued', 'suppressed_cap']);
    const capLog = await NotificationLog.findOne({ outboxId: second.outboxId });
    expect(capLog!.outcomeCode).toBe('CAP_SUPPRESSED');
    expect(capLog!.deliveryStatus).toBe('not_sent');

    await runOutboxDrain(new Date());
    const mobile = await mobileOf(buyer.counterpartyId);
    const mine = sent.filter((s) => s.toMobile === `91${mobile}`);
    expect(mine).toHaveLength(1); // The capped row is never sent.
    expect(mine[0]!.metaTemplateName).toBe('trifid_order_confirmed_en_v1');
  }, 60000);

  it('lets a message through again once the window has passed', async () => {
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    await enqueueOne(buyer.counterpartyId);
    await Counterparty.updateOne(
      { _id: buyer.counterpartyId },
      { $set: { lastWhatsAppQueuedAt: addDays(new Date(), -8) } },
    );
    const again = await enqueueOne(buyer.counterpartyId, 'refund_released');
    expect(again.suppressedByCap).toBe(false);
  }, 60000);

  it('is a hard cap under concurrency — five simultaneous triggers, one message', async () => {
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => enqueueOne(buyer.counterpartyId, 'pool_75')),
    );
    expect(results.filter((r) => !r.suppressedByCap)).toHaveLength(1);
    const rows = await outboxRows(buyer.counterpartyId);
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'suppressed_cap')).toHaveLength(4);
  }, 60000);

  it('does not touch calls — nothing in the cap path reads or writes a call record', () => {
    // BR-283 "Calls are not capped": the cap lives only in notification.outbox.ts.
    const source = readFileSync(
      join(process.cwd(), 'src/modules/notification/notification.outbox.ts'),
      'utf8',
    );
    expect(source).toContain('lastWhatsAppQueuedAt');
    expect(source.toLowerCase()).not.toContain('call log');
  });
});

// ---------------------------------------------------------------------------
// The drain, the ladder, the log, the poll
// ---------------------------------------------------------------------------

describe('BR-292 / BR-293 — the drain and the escalation ladder', () => {
  it('WhatsApp now → SMS at 2h → staff queue at 4h, each rung logged with a fixed outcome code', async () => {
    const { sent, smsSent } = installFakeTransports();
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const mobile = await mobileOf(buyer.counterpartyId);
    const { outboxId } = await enqueueOne(buyer.counterpartyId);

    const base = new Date();
    await runOutboxDrain(base);
    expect(sent.filter((s) => s.toMobile === `91${mobile}`)).toHaveLength(1);
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('undelivered');

    await runOutboxDrain(addMinutes(base, 119));
    expect(smsSent.filter((s) => s.toMobile === mobile)).toHaveLength(0); // Not yet — 1h59m.

    await runOutboxDrain(addHours(base, 2));
    expect(smsSent.filter((s) => s.toMobile === mobile)).toHaveLength(1);
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('undelivered'); // SMS is not the end.

    await runOutboxDrain(addMinutes(base, 239));
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('undelivered');

    await runOutboxDrain(addHours(base, 4));
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('staff_queue');
    // Idempotent: a further run neither re-sends the SMS nor re-escalates.
    await runOutboxDrain(addHours(base, 5));
    expect(smsSent.filter((s) => s.toMobile === mobile)).toHaveLength(1);

    const codes = (await NotificationLog.find({ outboxId }).sort({ _id: 1 })).map(
      (l) => l.outcomeCode,
    );
    expect(codes).toEqual(['WA_ACCEPTED', 'SMS_STUB_NOT_SENT', 'ESCALATED_TO_STAFF']);

    const controller = await staffToken(app, 'controller');
    const worklist = await request(app)
      .get('/api/v1/staff/notifications/worklist')
      .set('Authorization', `Bearer ${controller.token}`);
    expect(worklist.status).toBe(200);
    const queue = worklist.body.data.staffQueue as Array<{
      outboxId: string;
      toMobileMasked: string;
    }>;
    const item = queue.find((q) => q.outboxId === outboxId);
    expect(item).toBeDefined();
    expect(item!.toMobileMasked).not.toContain(mobile); // Masked, never the whole number.
  }, 60000);

  it('SMS is a stub: the default sender sends nothing and logs SMS_STUB_NOT_SENT', async () => {
    installFakeTransports();
    restoreRealTransports(); // Back to the real transport + the real stub SMS sender.
    const { setWhatsAppTransport } =
      await import('../src/modules/notification/notification.transport.js');
    setWhatsAppTransport({
      async send() {
        return {
          outcome: 'accepted',
          httpStatus: 200,
          providerMessageId: `w.${Math.random()}`,
          providerErrorCode: null,
        };
      },
      async fetchTemplateStatuses() {
        return [];
      },
    });
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const { outboxId } = await enqueueOne(buyer.counterpartyId);
    const base = new Date();
    await runOutboxDrain(base);
    await runOutboxDrain(addHours(base, 2));
    const sms = await NotificationLog.findOne({ outboxId, channel: 'sms' });
    expect(sms!.outcomeCode).toBe('SMS_STUB_NOT_SENT');
    expect(sms!.deliveryStatus).toBe('not_sent');
  }, 60000);

  it('an API failure is logged as WA_API_ERROR and still climbs the ladder', async () => {
    installFakeTransports({ failSends: true });
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const { outboxId } = await enqueueOne(buyer.counterpartyId);
    const base = new Date();
    await runOutboxDrain(base);
    const row = await NotificationOutbox.findById(outboxId);
    expect(row!.state).toBe('undelivered');
    const log = await NotificationLog.findOne({ outboxId });
    expect(log!.outcomeCode).toBe('WA_API_ERROR');
    expect(log!.response!.providerErrorCode).toBe('131000');
    await runOutboxDrain(addHours(base, 4));
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('staff_queue');
  }, 60000);

  it("Meta's signed delivery callback resolves a message and stops the ladder; a bad signature is refused", async () => {
    const { smsSent } = installFakeTransports();
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const mobile = await mobileOf(buyer.counterpartyId);
    const { outboxId } = await enqueueOne(buyer.counterpartyId);
    const base = new Date();
    await runOutboxDrain(base);
    const wamid = (await NotificationOutbox.findById(outboxId))!.providerMessageId!;

    const previousSecret = env.whatsappAppSecret;
    env.whatsappAppSecret = 'test-app-secret';
    try {
      const body = JSON.stringify({
        entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'delivered' }] } }] }],
      });
      const bad = await request(app)
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=deadbeef')
        .send(body);
      expect(bad.status).toBe(403);
      expect((await NotificationOutbox.findById(outboxId))!.state).toBe('undelivered');

      const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
      const good = await request(app)
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(body);
      expect(good.status).toBe(200);
    } finally {
      env.whatsappAppSecret = previousSecret;
    }

    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('delivered');
    await runOutboxDrain(addHours(base, 6));
    expect(smsSent.filter((s) => s.toMobile === mobile)).toHaveLength(0); // Delivered — no escalation.
    expect((await NotificationOutbox.findById(outboxId))!.state).toBe('delivered');
    expect(await NotificationLog.countDocuments({ outboxId, outcomeCode: 'WA_DELIVERED' })).toBe(1);
  }, 60000);

  it('the webhook refuses everything while no app secret is configured', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=anything')
      .send('{}');
    expect(res.status).toBe(403);
  });
});

describe('BR-295 — a paused template is detected by the poll, raises a worklist item, and is never replaced automatically', () => {
  it('polls Meta, marks the template paused, lists it on the worklist, sends nothing for it, and clears when approved again', async () => {
    const { sent, state } = installFakeTransports();
    const controller = await staffToken(app, 'controller');
    const worklistItems = async () => {
      const res = await request(app)
        .get('/api/v1/staff/notifications/worklist')
        .set('Authorization', `Bearer ${controller.token}`);
      expect(res.status).toBe(200);
      return res.body.data.pausedTemplates as Array<{
        templateKey: string;
        language: string;
        status: string;
      }>;
    };

    try {
      state.statuses = [
        { metaTemplateName: 'trifid_order_confirmed_en_v1', language: 'en', status: 'paused' },
      ];
      const summary = await runTemplateStatusPoll(new Date());
      expect(summary).toMatchObject({ polled: true, changed: 1 });
      expect(
        (await NotificationTemplate.findOne({ key: 'order_confirmed', language: 'en' }))!.status,
      ).toBe('paused');

      const items = await worklistItems();
      expect(
        items.find((i) => i.templateKey === 'order_confirmed' && i.language === 'en'),
      ).toMatchObject({
        status: 'paused',
      });
      // The Hindi row was not reported paused, so it is not on the list.
      expect(
        items.find((i) => i.templateKey === 'order_confirmed' && i.language === 'hi'),
      ).toBeUndefined();

      // A message needing the paused template is not sent, and the generic fallback is NOT substituted.
      const buyer = await newBuyer(app);
      await resetOutbox(buyer.counterpartyId);
      const mobile = await mobileOf(buyer.counterpartyId);
      const { outboxId } = await enqueueOne(buyer.counterpartyId, 'order_confirmed');
      await runOutboxDrain(new Date());
      expect((await NotificationLog.findOne({ outboxId }))!.outcomeCode).toBe(
        'TEMPLATE_UNAVAILABLE',
      );
      expect(sent.filter((s) => s.toMobile === `91${mobile}`)).toHaveLength(0);
      expect(sent.some((s) => s.metaTemplateName.includes('generic_fallback'))).toBe(false);
      expect(
        (await NotificationTemplate.findOne({ key: 'generic_fallback', language: 'en' }))!.status,
      ).toBe('approved');

      // Meta approves it again → the item clears itself.
      state.statuses = [
        { metaTemplateName: 'trifid_order_confirmed_en_v1', language: 'en', status: 'approved' },
      ];
      await runTemplateStatusPoll(new Date());
      const after = await worklistItems();
      expect(
        after.find((i) => i.templateKey === 'order_confirmed' && i.language === 'en'),
      ).toBeUndefined();
    } finally {
      await NotificationTemplate.updateOne(
        { key: 'order_confirmed', language: 'en' },
        { $set: { status: 'approved' } },
      );
    }
  }, 60000);

  it('with no WhatsApp credentials the poll does nothing and says so, rather than pretending', async () => {
    const { state } = installFakeTransports();
    state.statuses = null;
    expect(await runTemplateStatusPoll(new Date())).toEqual({
      polled: false,
      checked: 0,
      changed: 0,
    });
  });
});

describe('the notification log view (BR-293) — a read screen', () => {
  it('lists what was sent, to whom (masked), with fixed outcome codes; refuses roles without the permission', async () => {
    installFakeTransports();
    const buyer = await newBuyer(app);
    await resetOutbox(buyer.counterpartyId);
    const mobile = await mobileOf(buyer.counterpartyId);
    await enqueueOne(buyer.counterpartyId);
    await runOutboxDrain(new Date());

    const controller = await staffToken(app, 'controller');
    const res = await request(app)
      .get('/api/v1/staff/notifications/log?outcomeCode=WA_ACCEPTED&limit=200')
      .set('Authorization', `Bearer ${controller.token}`);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<{
      outcomeCode: string;
      toMobileMasked: string;
      templateKey: string;
    }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.outcomeCode === 'WA_ACCEPTED')).toBe(true);
    expect(items.some((i) => i.toMobileMasked.endsWith(mobile.slice(-4)))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(mobile); // Never the whole number.

    const badFilter = await request(app)
      .get('/api/v1/staff/notifications/log?outcomeCode=made_up_free_text')
      .set('Authorization', `Bearer ${controller.token}`);
    expect(badFilter.status).toBe(400); // Outcome codes are a fixed list.

    const sales = await staffToken(app, 'sales');
    const denied = await request(app)
      .get('/api/v1/staff/notifications/log')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(denied.status).toBe(403);
  }, 60000);
});

// ---------------------------------------------------------------------------
// The synchronous triggers — each fires from a real, pre-existing code path
// ---------------------------------------------------------------------------

describe('registration_invite — on approve and on reject', () => {
  it('approving a buyer and a seller each queue registration_invite (approved)', async () => {
    const buyer = await newBuyer(app);
    const seller = await newSeller(app);
    for (const party of [buyer, seller]) {
      const rows = await outboxRows(party.counterpartyId, 'registration_invite');
      expect(rows).toHaveLength(1);
      expect((rows[0]!.params as { outcome: string }).outcome).toBe('approved');
    }
  }, 60000);

  it('rejecting a registration queues registration_invite (rejected) with a coded outcome, never the free-text reason', async () => {
    const sales = await staffToken(app, 'sales');
    const { randomMobile, randomGstin } = await import('./helpers.js');
    const registerRes = await request(app)
      .post('/api/v1/registrations/buyer')
      .send({
        mobile: randomMobile(),
        firm: `Reject Me ${Date.now()}`,
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'LIC-9',
        gstPpobAddress: 'Somewhere',
        bankDetail: {
          accountNumber: `${Math.floor(1000000000 + Math.random() * 8999999999)}`,
          ifsc: 'HDFC0001234',
          accountName: 'A',
        },
        consent: { noticeVersion: 'v1', marketingOptIn: false },
      });
    const registrationId = registerRes.body.data.registrationId as string;
    const res = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/reject`)
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ reason: 'Documents unreadable — secret internal note' });
    expect(res.status).toBe(200);
    const rows = await outboxRows(registrationId, 'registration_invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params).toEqual({ outcome: 'rejected' });
  }, 60000);
});

describe('rate_ready — the FIRST quote landing on an ask, once', () => {
  it('queues rate_ready for the buyer on the first quote only, in the same transaction as the quote', async () => {
    const admin = await staffToken(app, 'admin');
    const buyer = await newBuyer(app);
    const sellerOne = await newSeller(app);
    const sellerTwo = await newSeller(app);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);

    const { askId } = await demandService.raiseAsk(buyer.counterpartyId, {
      skuId,
      allPacks: false,
      qty: 5,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const quote = {
      ratePaiseForIndore: 40000,
      qtyAvailable: 5,
      expiryBand: 'over12' as const,
      expiryExact: '06/2028',
      deliveryBand: '48h' as const,
      provenance: 'auth' as const,
      batch: 'B-1',
      daysToIndore: 2,
    };
    await demandService.postQuote(sellerOne.counterpartyId, askId, quote);
    await demandService.postQuote(sellerTwo.counterpartyId, askId, {
      ...quote,
      ratePaiseForIndore: 39000,
    });

    const rows = await outboxRows(buyer.counterpartyId, 'rate_ready');
    expect(rows).toHaveLength(1); // Two quotes, one "your rate is ready".
    expect((rows[0]!.params as { askId: string }).askId).toBe(askId);
  }, 60000);
});

describe('order_confirmed / payment_due / seller_requoted — the WF-05 pile paths', () => {
  it('confirming a pile queues payment_due THEN order_confirmed per buyer; the cap lets the money deadline win', async () => {
    const f = await seedTradeFixture(app);
    const productId = await productIdForSku(f.skuId);
    const sellerToken = await tokenFor(f.seller);
    const { lineIds } = await createListingViaApi(app, sellerToken, {
      productId,
      skuId: f.skuId,
      ratePaise: 40000,
    });
    const location = await createLocationFor(f.buyerDealer.docId, f.sales.employeeId);
    const inquire = await request(app)
      .post(`/api/v1/listings/lines/${lineIds[0]}/inquire`)
      .set('Authorization', `Bearer ${await tokenFor(f.buyerDealer)}`)
      .set('Idempotency-Key', idemKey())
      .send({ qty: 10, deliveryLocationId: location });
    const pileId = inquire.body.data.pileId as string;

    await resetOutbox(f.buyerDealer.counterpartyId);
    await demandService.confirmPile(
      f.seller.counterpartyId,
      pileId,
      { canSendBoxes: 10, expiryExact: '06/2028', batch: 'B-1' },
      'test',
    );
    await demandService.runConfirmPileFanout(pileId);

    const rows = await NotificationOutbox.find({
      counterpartyId: f.buyerDealer.counterpartyId,
      templateKey: { $in: ['payment_due', 'order_confirmed'] },
    }).sort({ _id: 1 });
    expect(rows.map((r) => r.templateKey)).toEqual(['payment_due', 'order_confirmed']);
    expect(rows.map((r) => r.state)).toEqual(['queued', 'suppressed_cap']);
  }, 60000);

  it('requoting a pile queues seller_requoted for every buyer on it', async () => {
    const f = await seedTradeFixture(app);
    const productId = await productIdForSku(f.skuId);
    const sellerToken = await tokenFor(f.seller);
    const { lineIds } = await createListingViaApi(app, sellerToken, {
      productId,
      skuId: f.skuId,
      ratePaise: 40000,
    });
    const buyers = [f.buyerRetailer, f.buyerDistributor];
    let pileId = '';
    for (const buyer of buyers) {
      const location = await createLocationFor(buyer.docId, f.sales.employeeId);
      const res = await request(app)
        .post(`/api/v1/listings/lines/${lineIds[0]}/inquire`)
        .set('Authorization', `Bearer ${await tokenFor(buyer)}`)
        .set('Idempotency-Key', idemKey())
        .send({ qty: 4, deliveryLocationId: location });
      pileId = res.body.data.pileId as string;
    }
    await demandService.requotePile(f.seller.counterpartyId, pileId);
    for (const buyer of buyers) {
      const rows = await outboxRows(buyer.counterpartyId, 'seller_requoted');
      expect(rows).toHaveLength(1);
      expect((rows[0]!.params as { pileId: string }).pileId).toBe(pileId);
    }
  }, 60000);
});

describe('pool_75 / pool_triggered — inside the commit handler, at the threshold crossing', () => {
  it('75% queues pool_75 for the soft committers; the trigger queues pool_triggered (not payment_due) for the binding ones', async () => {
    const f = await seedTradeFixture(app);
    const poolSku = await createTestSku('B');
    const productId = await productIdForSku(poolSku);
    const sellerToken = await tokenFor(f.seller);
    await createListingViaApi(app, sellerToken, {
      productId,
      skuId: poolSku,
      ratePaise: 40000,
      moqExact: 10,
    });
    const pool = await Pool.findOne({ skuId: poolSku, isActive: true });
    const poolId = String(pool!._id);

    const locations = {
      dealer: await createLocationFor(f.buyerDealer.docId, f.sales.employeeId),
      retailer: await createLocationFor(f.buyerRetailer.docId, f.sales.employeeId),
      distributor: await createLocationFor(f.buyerDistributor.docId, f.sales.employeeId),
    };
    await poolService.commitToPool(f.buyerDealer.counterpartyId, poolId, {
      qty: 6,
      deliveryLocationId: locations.dealer,
    });
    expect(await outboxRows(f.buyerDealer.counterpartyId, 'pool_75')).toHaveLength(0); // 60% — not yet.

    await poolService.commitToPool(f.buyerRetailer.counterpartyId, poolId, {
      qty: 4,
      deliveryLocationId: locations.retailer,
    });
    expect(await outboxRows(f.buyerDealer.counterpartyId, 'pool_75')).toHaveLength(1);
    expect(await outboxRows(f.buyerRetailer.counterpartyId, 'pool_75')).toHaveLength(1);

    await poolService.reconfirmPool(f.buyerDealer.counterpartyId, poolId);
    await poolService.commitToPool(f.buyerDistributor.counterpartyId, poolId, {
      qty: 4,
      deliveryLocationId: locations.distributor,
    });
    expect((await Pool.findById(poolId))!.status).toBe('triggered');

    expect(await outboxRows(f.buyerDealer.counterpartyId, 'pool_triggered')).toHaveLength(1);
    expect(await outboxRows(f.buyerDistributor.counterpartyId, 'pool_triggered')).toHaveLength(1);
    // The pool's own payment notice replaces payment_due — never both.
    expect(await outboxRows(f.buyerDealer.counterpartyId, 'payment_due')).toHaveLength(0);
    expect(await outboxRows(f.buyerDistributor.counterpartyId, 'payment_due')).toHaveLength(0);
    // The silent buyer was dropped at trigger and is told nothing more.
    expect(await outboxRows(f.buyerRetailer.counterpartyId, 'pool_triggered')).toHaveLength(0);
  }, 90000);
});

describe('the trade chain — po_released, lifeline_granted, inspection_outcome, short_dispatch, refund_released, dispatched, delivery_window', () => {
  it('each fires from its real service path as one order walks a part-rejection chain to leg-2 dispatch', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const accounts = await staffToken(app, 'accounts');
    const controller = await staffToken(app, 'controller');
    const logistics = await staffToken(app, 'transport_logistics');

    const buyerDocId = await createApprovedBuyer(app, sales.token);
    const sellerDocId = await createApprovedSeller(app, purchase.token);
    const buyerCp = String((await Buyer.findById(buyerDocId))!.counterpartyId);
    const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);
    const post = (path: string, token: string, body: object) =>
      request(app)
        .post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send(body);

    const so = await post('/staff/so', sales.token, {
      buyerId: buyerDocId,
      sellerId: sellerDocId,
      skuId,
      boxes: 10,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    });
    expect(so.status).toBe(201);
    const soId = so.body.data.soId as string;
    const soDoc = await So.findById(soId);

    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerDocId, {
      amountPaise: soDoc!.totalPaise,
      method: 'utr',
      utr: `UTR-${Date.now()}-${Math.random()}`,
    });
    await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
      employeeId: sales.employeeId,
      correlationId: 't',
    });
    await paymentService.postBankCredit(
      upcomingReceiptId,
      {
        utr: `STMT-${Date.now()}-${Math.random()}`,
        remitterAccountNumber: '1',
        remitterIfsc: 'HDFC0001234',
      },
      { employeeId: accounts.employeeId, correlationId: 't' },
    );

    const poRes = await post(`/staff/so/${soId}/po`, purchase.token, {});
    expect(poRes.status).toBe(201);
    const poId = poRes.body.data.poId as string;
    const poNo = poRes.body.data.poNo as string;
    const chainId = String((await Po.findById(poId))!.chainId);

    // po_released — the seller, from createPo.
    const released = await outboxRows(sellerCp, 'po_released');
    expect(released).toHaveLength(1);
    expect((released[0]!.params as { poNo: string }).poNo).toBe(poNo);

    // lifeline_granted — the seller, from the bulk lifeline (PO is still `released`).
    await controllerService.grantBulkLifeline(24, 'festival', {
      employeeId: controller.employeeId,
      checkerEmployeeId: admin.employeeId,
      correlationId: 't',
    });
    const lifeline = await outboxRows(sellerCp, 'lifeline_granted');
    expect(lifeline).toHaveLength(1);
    expect((lifeline[0]!.params as { extensionHours: number }).extensionHours).toBe(24);

    const leg1 = await post(`/staff/chains/${chainId}/movements`, logistics.token, {
      leg: 1,
      mode: 'bus',
      busNo: 'MP09AB1234',
      driver: 'Ramu',
      driverMobile: '9000000000',
      freightTerms: 'to_pay',
      freightAmountPaise: 0,
    });
    expect(leg1.status).toBe(201);

    // inspection_outcome — the seller, from recordInspection: part rejection.
    const inspect = await post(`/staff/pos/${poId}/inspections`, logistics.token, {
      casesAccepted: 6,
      casesRejected: 4,
      reasons: ['leakage'],
      photoRefs: ['p1'],
    });
    expect(inspect.status).toBe(201);
    const outcome = await outboxRows(sellerCp, 'inspection_outcome');
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.params).toEqual({ poNo, outcome: 'part_rejected' });

    expect((await post(`/staff/pos/${poId}/inspections/apply`, purchase.token, {})).status).toBe(
      200,
    );

    // short_dispatch — the buyer, from reduceSoQuantity.
    const reduce = await post(`/staff/so/${soId}/reduce-quantity`, sales.token, {
      newBoxes: 6,
      reason: 'part rejection',
      inspectionId: inspect.body.data.inspectionId,
    });
    expect(reduce.status).toBe(200);
    const shortRows = await outboxRows(buyerCp, 'short_dispatch');
    expect(shortRows).toHaveLength(1);
    expect((shortRows[0]!.params as { boxesShipped: number }).boxesShipped).toBe(6);

    // refund_released — the buyer, from releasePaymentRun.
    const refund = await Refund.findOne({ chainId: (await Po.findById(poId))!.chainId });
    const run = await paymentService.buildPaymentRun(
      [{ kind: 'refund', refId: String(refund!._id) }],
      { employeeId: accounts.employeeId, correlationId: 't' },
    );
    await paymentService.releasePaymentRun(
      run.paymentRunId,
      { utrs: ['REFUND-UTR-1'] },
      { employeeId: controller.employeeId, correlationId: 't' },
    );
    expect(await outboxRows(buyerCp, 'refund_released')).toHaveLength(1);

    const billedSo = await So.findById(soId);
    const marg = await post(`/staff/marg/${soId}`, accounts.token, {
      margInvoiceNo: `MARG-${Date.now()}`,
      date: new Date().toISOString(),
      valuePaise: billedSo!.totalPaise,
      ewayNo: 'EWAY-1',
    });
    expect(marg.status).toBe(201);

    // dispatched + delivery_window — the buyer, from the leg-2 transition, one transaction.
    const leg2 = await post(`/staff/chains/${chainId}/movements`, logistics.token, {
      leg: 2,
      mode: 'bus',
      busNo: 'MP09AB1234',
      driver: 'Ramu',
      driverMobile: '9000000000',
      freightTerms: 'to_pay',
      freightAmountPaise: 0,
    });
    expect(leg2.status).toBe(201);
    const dispatched = await outboxRows(buyerCp, 'dispatched');
    const windowRows = await outboxRows(buyerCp, 'delivery_window');
    expect(dispatched).toHaveLength(1);
    expect(windowRows).toHaveLength(1);
    expect((dispatched[0]!.params as { soNo: string }).soNo).toBe(billedSo!.soNo);
  }, 120000);
});

// ---------------------------------------------------------------------------
// Analytics — funnel and leak (BR-275), and the Founder view
// ---------------------------------------------------------------------------

type MetricKey =
  | 'blind_demand_eliminated'
  | 'time_to_confirm'
  | 'same_day_dispatch'
  | 'rejection_rate'
  | 'debits_recovered'
  | 'time_to_first_seller';

async function metric(key: MetricKey) {
  const report = await getFunnelReport();
  return report.metrics.find((m) => m.key === key)!;
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, keys));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

describe('BR-275 — funnel and leak analytics', () => {
  it('reports all six metrics, each stating its own formula; nothing tunable', async () => {
    const report = await getFunnelReport();
    expect(report.metrics.map((m) => m.key).sort()).toEqual([
      'blind_demand_eliminated',
      'debits_recovered',
      'rejection_rate',
      'same_day_dispatch',
      'time_to_confirm',
      'time_to_first_seller',
    ]);
    for (const m of report.metrics) {
      expect(m.formula.length, m.key).toBeGreaterThan(30); // A real sentence, not a label.
    }
    expect(report.windowDays).toBe(30);
  });

  it('is a Purchase surface: no rupee figure and no buyer identity in any key', async () => {
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .get('/api/v1/staff/purchase/funnel')
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(res.status).toBe(200);
    const keys = collectKeys(res.body.data);
    expect(
      keys.filter((k) => /paise|rupee|amount|price|rate(?!_)/i.test(k) && k !== 'rejection_rate'),
    ).toEqual([]);
    expect(keys.filter((k) => /buyer|firm|gstin|mobile|tehsil/i.test(k))).toEqual([]);

    const sales = await staffToken(app, 'sales');
    const denied = await request(app)
      .get('/api/v1/staff/purchase/funnel')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(denied.status).toBe(403);
  });

  it('rejection rate = cases rejected ÷ cases inspected (checked as exact numerator/denominator deltas)', async () => {
    const before = await metric('rejection_rate');
    await FabInspection.create({
      poId: new Types.ObjectId(),
      casesAccepted: 7,
      casesRejected: 3,
      reasons: ['leakage'],
      photoRefs: ['p'],
      signedBy: new Types.ObjectId(),
    });
    const after = await metric('rejection_rate');
    expect(after.numerator! - before.numerator!).toBe(3);
    expect(after.denominator! - before.denominator!).toBe(10);
  });

  it('blind demand eliminated counts flagged asks that later got a quote', async () => {
    const buyer = await newBuyer(app);
    const seller = await newSeller(app);
    const before = await metric('blind_demand_eliminated');
    const mk = () =>
      FabAsk.create({
        buyerId: buyer.docId,
        productId: new Types.ObjectId(),
        allPacks: true,
        qty: 2,
        conditionRequirement: { expiryBand: 'over12' },
        visibleToAllAt: new Date(),
        headStartOpenedAt: new Date(),
        ttlAt: addDays(new Date(), 30),
        state: 'open',
      });
    const [quotedLater, neverQuoted] = [await mk(), await mk()];
    for (const ask of [quotedLater, neverQuoted]) {
      await FabNonOrderReason.create({
        askId: ask._id,
        bucket: 'supply_gap',
        code: 'no_seller_in_scope',
        at: addHours(new Date(), -1),
        recordedBy: new Types.ObjectId(),
      });
    }
    await FabQuote.create({
      askId: quotedLater._id,
      sellerId: seller.docId,
      ratePaiseForIndore: 40000,
      qtyAvailable: 2,
      conditionSet: {
        expiryBand: 'over12',
        expiryExact: '06/2028',
        deliveryBand: '48h',
        provenance: 'auth',
        batch: 'B',
      },
      daysToIndore: 2,
      bindingUntil: addDays(new Date(), 1),
      status: 'live',
    });
    const after = await metric('blind_demand_eliminated');
    expect(after.denominator! - before.denominator!).toBe(2);
    expect(after.numerator! - before.numerator!).toBe(1);
  }, 60000);

  it('time to first seller counts an ask once it has a quote; an unquoted ask is left out, not counted as zero', async () => {
    const buyer = await newBuyer(app);
    const seller = await newSeller(app);
    const before = await metric('time_to_first_seller');
    const mk = () =>
      FabAsk.create({
        buyerId: buyer.docId,
        productId: new Types.ObjectId(),
        allPacks: true,
        qty: 2,
        conditionRequirement: { expiryBand: 'over12' },
        visibleToAllAt: new Date(),
        headStartOpenedAt: new Date(),
        ttlAt: addDays(new Date(), 30),
        state: 'open',
      });
    const quoted = await mk();
    await mk(); // No quote.
    await FabQuote.create({
      askId: quoted._id,
      sellerId: seller.docId,
      ratePaiseForIndore: 40000,
      qtyAvailable: 2,
      conditionSet: {
        expiryBand: 'over12',
        expiryExact: '06/2028',
        deliveryBand: '48h',
        provenance: 'auth',
        batch: 'B',
      },
      daysToIndore: 2,
      bindingUntil: addDays(new Date(), 1),
      status: 'live',
    });
    const after = await metric('time_to_first_seller');
    expect(after.denominator! - before.denominator!).toBe(1);
  }, 60000);

  it('same-day dispatch: a same-IST-day dispatch is a hit; a past release day with no dispatch is a miss', async () => {
    const before = await metric('same_day_dispatch');
    const mkPo = (createdAt: Date) =>
      FabPo.create({
        poNo: `PO-M8-${Math.random()}`,
        chainId: new Types.ObjectId(),
        soId: new Types.ObjectId(),
        sellerId: new Types.ObjectId(),
        state: 'released',
        dispatchDueDate: createdAt,
        promisedOutOfIndoreBy: createdAt,
        createdAt,
      });
    const hit = await mkPo(new Date());
    await FabMovement.create({
      chainId: hit.chainId,
      leg: 1,
      mode: 'bus',
      freightTerms: 'to_pay',
      freightAmountPaise: 0,
      recordedBy: new Types.ObjectId(),
    });
    const missReleased = addDays(new Date(), -3);
    await mkPo(missReleased);
    expect(istDateKey(missReleased) < istDateKey(new Date())).toBe(true);
    const after = await metric('same_day_dispatch');
    expect(after.denominator! - before.denominator!).toBe(2);
    expect(after.numerator! - before.numerator!).toBe(1);
  }, 60000);

  it('time to confirm averages first request → confirmation on confirmed piles', async () => {
    const buyer = await newBuyer(app);
    const before = await metric('time_to_confirm');
    const opened = addHours(new Date(), -5);
    const pile = await FabPile.create({
      listingLineId: new Types.ObjectId(),
      openedAt: opened,
      confirmWindowEndsAt: addHours(opened, 12),
      decision: 'confirmed',
      decidedAt: new Date(),
    });
    await FabPileRequest.create({
      pileId: pile._id,
      buyerId: buyer.docId,
      qty: 1,
      deliveryLocationId: new Types.ObjectId(),
      requestedAt: opened,
    });
    const after = await metric('time_to_confirm');
    expect(after.denominator! - before.denominator!).toBe(1);
    expect(after.value).not.toBeNull();
  }, 60000);

  it('debits recovered is a count of debits netted, never a rupee figure', async () => {
    const before = await metric('debits_recovered');
    await FabSellerDebit.create({
      counterpartyId: new Types.ObjectId(),
      amountPaise: 500,
      reason: 'x',
    });
    await FabSellerDebit.create({
      counterpartyId: new Types.ObjectId(),
      amountPaise: 700,
      reason: 'y',
      nettedAgainst: new Types.ObjectId(),
    });
    const after = await metric('debits_recovered');
    expect(after.denominator! - before.denominator!).toBe(2);
    expect(after.numerator! - before.numerator!).toBe(1);
    expect(after.caveat).toContain('netting');
  }, 60000);
});

describe("GET /founder/overview — read-only, and sharing Controller's query path", () => {
  it('returns the standing figures for a Founder; refuses Sales and Purchase', async () => {
    const founder = await staffToken(app, 'founder');
    const res = await request(app)
      .get('/api/v1/founder/overview')
      .set('Authorization', `Bearer ${founder.token}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.buyerMoneyHeld).toMatchObject({
      heldPaise: expect.any(Number),
      formula: expect.any(String),
    });
    expect(data.buyerMoneyHeld.heldPaise).toBe(
      data.buyerMoneyHeld.undeliveredOrdersPaise + data.buyerMoneyHeld.pendingRefundsPaise,
    );
    expect(data.funnel.metrics).toHaveLength(6);
    expect(data.exceptions).toHaveProperty('openDisputes');
    // The deliberately-not-built recommendation is absent.
    expect(JSON.stringify(data)).not.toMatch(/exposure|debitCap|debit_cap/i);

    for (const role of ['sales', 'purchase', 'accounts']) {
      const other = await staffToken(app, role);
      const denied = await request(app)
        .get('/api/v1/founder/overview')
        .set('Authorization', `Bearer ${other.token}`);
      expect(denied.status, role).toBe(403);
    }
  }, 60000);

  it('has no way to write: POST/PUT/PATCH/DELETE on /founder/overview all miss', async () => {
    const founder = await staffToken(app, 'founder');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)
        [method]('/api/v1/founder/overview')
        .set('Authorization', `Bearer ${founder.token}`)
        .send({});
      expect(res.status, method).toBe(404);
    }
  });

  it('shows the same exception numbers as Controller — before and after the underlying data changes', async () => {
    const founder = await staffToken(app, 'founder');
    const controller = await staffToken(app, 'controller');
    const fetchBoth = async () => {
      const f = await request(app)
        .get('/api/v1/founder/overview')
        .set('Authorization', `Bearer ${founder.token}`);
      const c = await request(app)
        .get('/api/v1/staff/controller/exceptions')
        .set('Authorization', `Bearer ${controller.token}`);
      expect(f.status).toBe(200);
      expect(c.status).toBe(200);
      return { founder: f.body.data.exceptions, controller: c.body.data };
    };

    const first = await fetchBoth();
    expect(first.founder).toEqual(first.controller);

    const complaint = await FabComplaint.create({
      soId: new Types.ObjectId(),
      buyerId: new Types.ObjectId(),
      category: 'short_count_on_arrival',
      state: 'open',
    });
    try {
      const second = await fetchBoth();
      expect(second.founder).toEqual(second.controller);
      expect(second.founder.openDisputes).toBe(first.founder.openDisputes + 1); // Both moved, together.
    } finally {
      await Complaint.deleteOne({ _id: complaint._id });
    }
  }, 60000);

  it('proves a shared query path by construction: the Founder module owns no query of its own', () => {
    const founder = readFileSync(
      join(process.cwd(), 'src/modules/founder/founder.service.ts'),
      'utf8',
    );
    expect(founder).toContain("from '../controller/controller.service.js'");
    expect(founder).toContain('getExceptionView');
    expect(founder).toContain("from '../desk/purchase/purchase.funnel.js'");
    expect(founder).toContain("from '../payment/payment.service.js'");
    // No model import, no direct database call — it can only call the owning functions.
    expect(founder).not.toMatch(/models\//);
    expect(founder).not.toMatch(/\.(find|findOne|countDocuments|aggregate)\(/);
    // And Controller's own route calls the very same function.
    const controllerController = readFileSync(
      join(process.cwd(), 'src/modules/controller/controller.controller.ts'),
      'utf8',
    );
    expect(controllerController).toContain('controllerService.getExceptionView');
  });

  it('BR-026 — buyer money held rises by an order paid and undelivered, and not by an unpaid one', async () => {
    const { getBuyerMoneyHeld } = paymentService;
    const before = await getBuyerMoneyHeld();
    const buyer = await newBuyer(app);
    await FabSo.create({
      soNo: `SO-M8-${Math.random()}`,
      chainId: new Types.ObjectId(),
      buyerId: buyer.docId,
      sellerId: new Types.ObjectId(),
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'dispatched_leg1',
      payDeadline: new Date(),
      totalPaise: 123400,
    });
    await FabSo.create({
      soNo: `SO-M8-${Math.random()}`,
      chainId: new Types.ObjectId(),
      buyerId: buyer.docId,
      sellerId: new Types.ObjectId(),
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'awaiting_payment',
      payDeadline: new Date(),
      totalPaise: 999900,
    });
    await FabSo.create({
      soNo: `SO-M8-${Math.random()}`,
      chainId: new Types.ObjectId(),
      buyerId: buyer.docId,
      sellerId: new Types.ObjectId(),
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'closed',
      payDeadline: new Date(),
      totalPaise: 555500,
    });
    const after = await getBuyerMoneyHeld();
    expect(after.undeliveredOrdersPaise - before.undeliveredOrdersPaise).toBe(123400); // Paid+undelivered only.
  }, 60000);
});
