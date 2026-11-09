import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { StaffNotice } from '../src/models/StaffNotice.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import { runConfirmedPileRecovery } from '../src/modules/demand/pileRecovery.job.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * BR-137 / BR-378 — a confirmed pile gives each buyer his deal in a job scheduled 5 seconds later.
 * When that job failed, nothing ran it again: the pile sat "confirmed", off every queue, with no one
 * told. The recovery job retries it, keeps it in sight on Purchase › Confirmations, and tells staff
 * once if it still will not go through.
 */
const app = createApp();
const MIN = 60_000;
const HOUR = 60 * MIN;

let admin: { token: string; employeeId: string };
let sales: { token: string; employeeId: string };
let purchase: { token: string; employeeId: string };

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  sales = await staffToken(app, 'sales');
  purchase = await staffToken(app, 'purchase');
}, 60000);

// Each test sees only its own stuck pile and its own notices.
beforeEach(async () => {
  await Pile.updateMany(
    { decision: 'confirmed', executedAt: null },
    { $set: { executedAt: new Date() } },
  );
  await StaffNotice.deleteMany({ kind: 'pile_stuck' });
});

interface World {
  lineId: string;
  pileId: string;
  requestIds: string[];
}

/** A 20-box line; three buyers ask 6, 5 and 4; the seller confirms all 15. The fan-out has NOT run. */
async function confirmedPile(): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyerCps: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const docId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    buyerCps.push(String((await Buyer.findById(docId))!.counterpartyId));
  }
  await createListing(sellerCp, {
    productId: String((await Sku.findById(skuId))!.productId),
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise: 40000,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '48h',
        provenance: 'company',
        qty: 20,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  let pileId = '';
  for (const [i, qty] of [6, 5, 4].entries()) {
    pileId = (await createPileRequest(buyerCps[i]!, lineId, { qty })).pileId;
  }
  await demandService.confirmPile(
    sellerCp,
    pileId,
    { canSendBoxes: 15, expiryExact: '06/2028' },
    randomUUID(),
  );
  const requests = await PileRequest.find({ pileId }).sort({ requestedAt: 1 });
  return { lineId, pileId, requestIds: requests.map((r) => String(r._id)) };
}

/** Pretend the pile was confirmed `ms` ago. */
const confirmedAgo = (pileId: string, ms: number) =>
  Pile.updateOne({ _id: pileId }, { $set: { decidedAt: new Date(Date.now() - ms) } });

const getAs = (token: string, path: string) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

describe('the fan-out is safe to run more than once', () => {
  it('gives each buyer one deal even when it runs twice at the same moment', async () => {
    const w = await confirmedPile();
    await Promise.all([runConfirmPileFanout(w.pileId), runConfirmPileFanout(w.pileId)]);

    const requests = await PileRequest.find({ pileId: w.pileId });
    expect(requests.every((r) => r.offerState === 'offered')).toBe(true);
    // One "your rate is ready" message per buyer, not two.
    expect(
      await NotificationOutbox.countDocuments({
        templateKey: 'rate_ready',
        correlationId: { $in: w.requestIds.map((id) => `pile-offer-${id}`) },
      }),
    ).toBe(3);
    // The 15 boxes come off the 20-box line once.
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(5);
    expect((await Pile.findById(w.pileId))!.executedAt).not.toBeNull();
  });

  it('does not touch a pile that was already given out', async () => {
    const w = await confirmedPile();
    await runConfirmPileFanout(w.pileId);
    const before = await PileRequest.find({ pileId: w.pileId }).sort({ requestedAt: 1 });
    await runConfirmPileFanout(w.pileId);
    const after = await PileRequest.find({ pileId: w.pileId }).sort({ requestedAt: 1 });
    expect(after.map((r) => String(r.holdUntil))).toEqual(before.map((r) => String(r.holdUntil)));
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(5);
  });
});

describe('the recovery job', () => {
  it('gives the buyers their deal when the scheduled fan-out never ran', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 3 * MIN);

    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 1, flagged: 0 });

    const requests = await PileRequest.find({ pileId: w.pileId });
    expect(requests.every((r) => r.offerState === 'offered')).toBe(true);
    expect((await Pile.findById(w.pileId))!.executedAt).not.toBeNull();
    // It worked, so no one is told.
    expect(await StaffNotice.countDocuments({ kind: 'pile_stuck' })).toBe(0);
  });

  it('leaves a pile alone in its first two minutes', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 30_000);

    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 0, flagged: 0 });
    expect((await Pile.findById(w.pileId))!.executedAt).toBeNull();
  });

  it('tells staff once, and keeps the reason, when a retry still fails', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 3 * MIN);
    await ListingLine.deleteOne({ _id: w.lineId }); // The fan-out cannot find its line.

    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 0, flagged: 1 });
    const pile = (await Pile.findById(w.pileId))!;
    expect(pile.executedAt).toBeNull();
    expect(pile.stuckNoticedAt).not.toBeNull();
    expect(pile.fanoutError).toContain('Listing line not found');

    const notices = await StaffNotice.find({ kind: 'pile_stuck' });
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices.map((n) => String(n.employeeId))).toContain(admin.employeeId);
    expect(notices[0]).toMatchObject({
      link: '/purchase/confirmations',
      title: expect.stringContaining('Confirmation not completed'),
    });
    expect(notices[0]!.body).toContain('retried every 5 minutes');

    // The next run retries again but does not tell anyone a second time.
    const told = notices.length;
    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 0, flagged: 0 });
    expect(await StaffNotice.countDocuments({ kind: 'pile_stuck' })).toBe(told);
  });

  it('flags, but does not retry, a pile confirmed more than 24 hours ago', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 25 * HOUR);

    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 0, flagged: 1 });
    const pile = (await Pile.findById(w.pileId))!;
    expect(pile.executedAt).toBeNull(); // Stale demand is the desk's decision, not a timer's.
    expect(pile.fanoutError).toContain('24 hours');
    expect((await PileRequest.find({ pileId: w.pileId })).every((r) => r.offerState === null)).toBe(
      true,
    );
    const notice = (await StaffNotice.findOne({ kind: 'pile_stuck' }))!;
    expect(notice.body).toContain('too old to retry automatically');

    expect(await runConfirmedPileRecovery()).toEqual({ recovered: 0, flagged: 0 });
  });
});

describe('Purchase › Confirmations — confirmed, deal not given yet', () => {
  it('keeps the stuck pile in sight, with buyer counts only', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 10 * MIN);

    const res = await getAs(purchase.token, '/staff/purchase/piles/not-completed');
    expect(res.status).toBe(200);
    const items = res.body.data as Array<Record<string, unknown>>;
    const item = items.find((i) => i.pileId === w.pileId)!;
    expect(item).toMatchObject({
      boxes: 15,
      buyers: 3,
      retrying: true,
      lastError: null,
      minutesSinceConfirmed: 10,
    });
    // BR-365 — Purchase never sees a buyer: a count, no names, no ids.
    expect(Object.keys(item).sort()).toEqual(
      [
        'boxes',
        'brand',
        'buyers',
        'confirmedAt',
        'lastError',
        'minutesSinceConfirmed',
        'packLabel',
        'pileId',
        'retrying',
        'sellerFirm',
        'sellerId',
      ].sort(),
    );
  });

  it('does not list a pile in its first two minutes, or one that has been given out', async () => {
    const fresh = await confirmedPile();
    await confirmedAgo(fresh.pileId, 30_000);
    const done = await confirmedPile();
    await confirmedAgo(done.pileId, 10 * MIN);
    await runConfirmPileFanout(done.pileId);

    const items = (await getAs(purchase.token, '/staff/purchase/piles/not-completed')).body
      .data as Array<{ pileId: string }>;
    expect(items.map((i) => i.pileId)).not.toContain(fresh.pileId);
    expect(items.map((i) => i.pileId)).not.toContain(done.pileId);
  });

  it('shows the last error and marks a pile past its 24 hours as no longer retrying', async () => {
    const w = await confirmedPile();
    await confirmedAgo(w.pileId, 26 * HOUR);
    await runConfirmedPileRecovery();

    const items = (await getAs(purchase.token, '/staff/purchase/piles/not-completed')).body
      .data as Array<{ pileId: string; retrying: boolean; lastError: string | null }>;
    const item = items.find((i) => i.pileId === w.pileId)!;
    expect(item.retrying).toBe(false);
    expect(item.lastError).toContain('24 hours');
  });

  it('is closed to anyone who is not signed in', async () => {
    const res = await request(app).get('/api/v1/staff/purchase/piles/not-completed');
    expect(res.status).toBe(401);
  });
});
