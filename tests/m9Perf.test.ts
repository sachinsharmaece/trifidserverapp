import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Bankbook } from '../src/models/Bankbook.js';
import { Chain } from '../src/models/Chain.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { NotificationTemplate } from '../src/models/NotificationTemplate.js';
import { Po } from '../src/models/Po.js';
import { Quote } from '../src/models/Quote.js';
import { SellerArea } from '../src/models/SellerArea.js';
import { SellerBlock } from '../src/models/SellerBlock.js';
import { So } from '../src/models/So.js';
import { Tehsil } from '../src/models/Tehsil.js';
import * as listingService from '../src/modules/listing/listing.service.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import { createApprovedBuyerAtTehsil } from './m5helpers.js';
import { newSeller, partyOf } from './m8helpers.js';

/**
 * Milestone 9 — performance, measured rather than assumed. Numbers are printed
 * (console.info) so they can be quoted; the assertions are deliberately generous
 * ceilings, there to catch a regression in KIND (a collection scan, an N+1), not
 * to police milliseconds on a laptop.
 */
const app = createApp();

/** Every stage name in an explain plan, however deeply nested. */
function stagesOf(plan: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'stage' && typeof v === 'string') out.push(v);
        visit(v);
      }
    }
  };
  visit(plan);
  return out;
}

async function explain(cursor: { explain: (v: string) => Promise<unknown> }) {
  const result = (await cursor.explain('executionStats')) as {
    queryPlanner: { winningPlan: unknown };
    executionStats: { totalDocsExamined: number; nReturned: number; executionTimeMillis: number };
  };
  return {
    stages: stagesOf(result.queryPlanner.winningPlan),
    docsExamined: result.executionStats.totalDocsExamined,
    returned: result.executionStats.nReturned,
    ms: result.executionStats.executionTimeMillis,
  };
}

describe('DATA_MODEL §7 — the documented indexes exist in the database, and the job queries use them', () => {
  // `key` is what the MODEL actually declares. Two names in DATA_MODEL §7 have drifted from
  // the code (`quote.ratePaise` is `ratePaiseForIndore`; `audit_log.at` is `createdAt`), and one
  // documented index — `listing_line {skuId, state}` — does not exist: ListingLine has no `state`.
  // The drift is recorded in the M9 CHANGELOG entry; this table is what is actually true.
  const documented: Array<{
    name: string;
    model: {
      init: () => Promise<unknown>;
      collection: { indexes: () => Promise<Array<{ key: Record<string, number> }>> };
    };
    key: Record<string, number>;
  }> = [
    { name: 'seller_area', model: SellerArea, key: { tehsilId: 1 } },
    { name: 'listing', model: Listing, key: { state: 1, expiresAt: 1 } },
    { name: 'so', model: So, key: { state: 1, payDeadline: 1 } },
    { name: 'po', model: Po, key: { state: 1, dispatchDueDate: 1 } },
    { name: 'quote', model: Quote, key: { askId: 1, ratePaiseForIndore: 1 } },
    { name: 'seller_block', model: SellerBlock, key: { sellerId: 1, gstin: 1 } },
    { name: 'bankbook', model: Bankbook, key: { utr: 1 } },
    { name: 'chain', model: Chain, key: { stage: 1 } },
    { name: 'audit_log', model: AuditLog, key: { entity: 1, entityId: 1, createdAt: -1 } },
    {
      name: 'notification_outbox (drain)',
      model: NotificationOutbox,
      key: { state: 1, scheduledFor: 1 },
    },
    {
      name: 'notification_outbox (log/cap)',
      model: NotificationOutbox,
      key: { counterpartyId: 1, createdAt: -1 },
    },
    { name: 'notification_template', model: NotificationTemplate, key: { key: 1, language: 1 } },
  ];

  it('every index is really in the database, not just declared in a schema', async () => {
    const missing: string[] = [];
    for (const { name, model, key } of documented) {
      await model.init();
      const present = (await model.collection.indexes()).some(
        (index) => JSON.stringify(index.key) === JSON.stringify(key),
      );
      if (!present) missing.push(`${name} ${JSON.stringify(key)}`);
    }
    expect(missing).toEqual([]);
  });

  it('the payment-window, dispatch-chase and outbox-drain queries are index scans, never collection scans', async () => {
    const now = new Date();
    const plans = {
      paymentWindow: await explain(
        So.find({ state: 'awaiting_payment', payDeadline: { $lt: now } }),
      ),
      dispatchChase: await explain(Po.find({ state: 'released', dispatchDueDate: { $lt: now } })),
      outboxDrain: await explain(
        NotificationOutbox.find({ state: 'queued', scheduledFor: { $lte: now } }),
      ),
      chainStage: await explain(Chain.find({ stage: 'po' })),
    };
    for (const [name, plan] of Object.entries(plans)) {
      console.info(`explain ${name}: ${plan.stages.join(' > ')} examined=${plan.docsExamined}`);
      expect(plan.stages, name).toContain('IXSCAN');
      expect(plan.stages, name).not.toContain('COLLSCAN');
    }
  });
});

describe('the resolver and the buyer feed, at a realistic scale', () => {
  it('3,000 tehsils, 400 live listings (100 of them all-India): the feed query, explained — and the index it lacks', async () => {
    const TEHSILS = 3000;
    const LISTINGS = 400;
    const ALL_INDIA = 100;

    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);

    const tag = `perf-${Date.now()}`;
    const tehsils = await Tehsil.insertMany(
      Array.from({ length: TEHSILS }, (_, i) => ({
        name: `${tag}-${i}`,
        district: `D${i % 60}`,
        state: 'MP',
      })),
    );
    const allIds = tehsils.map((t) => t._id as Types.ObjectId);
    const buyerTehsil = String(allIds[1234]);

    const sellers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => newSeller(app)));
    const skuIds = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => createTestSku('B')));
    const skus = await (await import('../src/models/Sku.js')).Sku.find({ _id: { $in: skuIds } });
    const productOf = new Map(skus.map((s) => [String(s._id), s.productId as Types.ObjectId]));

    const buyer = await partyOf(
      'buyer',
      await createApprovedBuyerAtTehsil(app, sales.token, buyerTehsil, 'dealer'),
    );

    const expiresAt = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const listingDocs = Array.from({ length: LISTINGS }, (_, i) => {
      const skuId = skuIds[i % skuIds.length]!;
      const isAllIndia = i < ALL_INDIA;
      const mine = i % 3 === 0; // a third of the my-area listings reach this buyer
      return {
        productId: productOf.get(String(skuId))!,
        sellerId: new Types.ObjectId(sellers[i % sellers.length]!.docId),
        origin: 'seller_initiated',
        scopeType: isAllIndia ? 'all_india' : 'my_area',
        frozenTehsilIds: isAllIndia
          ? allIds
          : [allIds[(i * 7) % TEHSILS]!, ...(mine ? [allIds[1234]!] : [])],
        state: 'live',
        expiresAt,
        _skuId: skuId,
      };
    });
    const listings = await Listing.insertMany(
      listingDocs.map((doc) => ({ ...doc, _skuId: undefined })),
    );
    await ListingLine.insertMany(
      listings.map((l, i) => ({
        listingId: l._id,
        skuId: listingDocs[i]!._skuId,
        ratePaise: 40000 + i,
        expiryBand: 'over12',
        moqExact: 1,
        moqBand: '1',
        deliveryBand: '48h',
        provenance: 'auth',
        batch: 'B1',
        qty: 100,
      })),
    );

    // 1. The query the feed runs first, explained.
    const filter = { state: 'live', frozenTehsilIds: new Types.ObjectId(buyerTehsil) };
    const before = await explain(Listing.find(filter));
    console.info(
      `feed query WITHOUT a frozenTehsilIds index: ${before.stages.join(' > ')} ` +
        `examined=${before.docsExamined} returned=${before.returned} ${before.ms}ms`,
    );

    // 2. The whole feed, three times (first is cold).
    const timings: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const feed = await listingService.getBuyerFeed(buyer.counterpartyId, 0, 50);
      timings.push(Math.round(performance.now() - started));
      expect(feed.items.length).toBeGreaterThan(0);
    }
    console.info(`getBuyerFeed at scale (ms, cold then warm): ${timings.join(', ')}`);

    // 3. What the missing multikey index would buy — measured, then removed again.
    await Listing.collection.createIndex({ frozenTehsilIds: 1, state: 1 }, { name: 'perf_probe' });
    let after;
    try {
      after = await explain(Listing.find(filter).hint('perf_probe'));
    } finally {
      await Listing.collection.dropIndex('perf_probe');
    }
    console.info(
      `feed query WITH a {frozenTehsilIds, state} index: ${after.stages.join(' > ')} ` +
        `examined=${after.docsExamined} returned=${after.returned} ${after.ms}ms`,
    );

    // The finding, asserted so it cannot silently change: today the query is an index scan on
    // `state` alone, so it fetches every live listing to test the tehsil in memory.
    expect(before.stages).toContain('IXSCAN');
    expect(before.docsExamined).toBeGreaterThanOrEqual(LISTINGS);
    // A multikey index reads only the listings that reach this buyer.
    expect(after.docsExamined).toBe(after.returned);
    expect(after.docsExamined).toBeLessThan(before.docsExamined);
    // Ceiling on the whole feed at this scale. It is set BELOW the ~1.3 s the per-line pricing
    // N+1 used to cost (measured ~0.45 s since), so that regression cannot return unnoticed.
    expect(Math.min(...timings)).toBeLessThan(1000);
  }, 240000);
});

describe('a real month of day-closes (BR-308, INV-09)', () => {
  it('ten consecutive nil day-closes against an INDEPENDENT statement balance, with a month’s postings between them', async () => {
    const accounts = await staffToken(app, 'accounts');
    const partyId = new Types.ObjectId();

    // The statement side is tracked here, by the test, from the amounts it generates —
    // never by calling the code under test. (M7's version compared the book with itself.)
    let statementClosing = await paymentService.computeBankbookClosingPaise();
    let rows = 0;
    const closeTimes: number[] = [];

    for (let day = 0; day < 10; day += 1) {
      // ~2,000 lines a day ≈ a month's volume across ten closes: receipts in, payouts and refunds out.
      const batch = Array.from({ length: 2000 }, (_, i) => {
        const kind = i % 3 === 0 ? 'out' : 'in';
        const amountPaise = 10_000 + ((day * 2000 + i) % 977) * 100;
        statementClosing += kind === 'in' ? amountPaise : -amountPaise;
        return {
          date: new Date(),
          kind,
          purpose: kind === 'in' ? 'receipt' : i % 2 ? 'payout' : 'refund',
          partyId,
          partyType: kind === 'in' ? 'buyer' : 'seller',
          amountPaise,
          postedBy: new Types.ObjectId(),
        };
      });
      await Bankbook.insertMany(batch);
      rows += batch.length;

      const started = performance.now();
      const closed = await paymentService.runDayClose(statementClosing, {
        employeeId: accounts.employeeId,
        correlationId: `m9-month-${day}`,
      });
      closeTimes.push(Math.round(performance.now() - started));
      expect(closed.closingPaise).toBe(statementClosing); // nil difference, independently derived
    }
    console.info(
      `day close over ${rows} new lines (book now ${await Bankbook.countDocuments()}): ${closeTimes.join(', ')} ms`,
    );

    // And it still refuses a book that is one paisa out — the guard did not go slack at scale.
    await expect(
      paymentService.runDayClose(statementClosing + 1, {
        employeeId: accounts.employeeId,
        correlationId: 'm9-month-off',
      }),
    ).rejects.toMatchObject({ code: 'DAY_CLOSE_OUT_OF_BALANCE' });
    expect(Math.max(...closeTimes)).toBeLessThan(10_000);
  }, 240000);
});
