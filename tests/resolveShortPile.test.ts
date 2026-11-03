import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { CallLog } from '../src/models/CallLog.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { So } from '../src/models/So.js';
import { SoLine } from '../src/models/SoLine.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import { acceptOffer, declineOffer } from './pileOfferHelpers.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { closedStateByLine } from '../src/modules/listing/listing.groups.js';
import { listShortPiles, resolveShortPile } from '../src/modules/desk/sales/sales.shortPiles.js';
import type { Visibility } from '../src/shared/scope.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * 2 Nov — BR-134: a pile the seller cannot fully supply is divided between its buyers by the desk
 * (Sales), with no automatic rule. Until then the line is shut ("short"); afterwards the orders are
 * made for the buyers who got boxes, and what a buyer asked for and did not get is open as an ask.
 */
const app = createApp();
const everyone: Visibility = {
  all: true,
  allowsProfile: () => true,
  allowsCounterparty: () => true,
};
const actor = () => ({ employeeId: sales.employeeId, correlationId: randomUUID() });

let admin: { token: string; employeeId: string };
let sales: { token: string; employeeId: string };
let purchase: { token: string; employeeId: string };

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  sales = await staffToken(app, 'sales');
  purchase = await staffToken(app, 'purchase');
}, 60000);

interface World {
  lineId: string;
  pileId: string;
  buyers: Array<{ docId: string; cp: string }>;
  requestIds: string[];
}

/** A line of `lineQty` boxes; three buyers ask 6, 5 and 4 (15 in all); the seller confirms `canSend`. */
async function shortPile(lineQty = 10, canSend = 10): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyers: World['buyers'] = [];
  for (let i = 0; i < 3; i += 1) {
    const docId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    buyers.push({ docId, cp: String((await Buyer.findById(docId))!.counterpartyId) });
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
        qty: lineQty,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  let pileId = '';
  for (const [i, qty] of [6, 5, 4].entries()) {
    pileId = (await createPileRequest(buyers[i]!.cp, lineId, { qty })).pileId;
  }
  await demandService.confirmPile(
    sellerCp,
    pileId,
    { canSendBoxes: canSend, expiryExact: '06/2028' },
    randomUUID(),
  );
  await runConfirmPileFanout(pileId);
  const requests = await PileRequest.find({ pileId }).sort({ requestedAt: 1 });
  return { lineId, pileId, buyers, requestIds: requests.map((r) => String(r._id)) };
}

const split = (w: World, boxes: number[]) =>
  w.requestIds.map((pileRequestId, i) => ({ pileRequestId, boxes: boxes[i]! }));

async function boxesOrdered(buyerDocId: string): Promise<number> {
  const sos = await So.find({ buyerId: buyerDocId });
  const lines = await SoLine.find({ soId: { $in: sos.map((s) => s._id) } });
  return lines.reduce((sum, l) => sum + l.boxes, 0);
}

describe('A short pile waits for the desk (BR-134)', () => {
  it('the fan-out makes no order; the line is shut as "short" and says why', async () => {
    const w = await shortPile();
    expect(await So.countDocuments({ pileRequestId: { $in: w.requestIds } })).toBe(0);
    const pile = await Pile.findById(w.pileId);
    expect(pile).toMatchObject({ shortfall: true, shortfallResolvedAt: null });
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(10); // Nothing taken off yet.

    const line = await ListingLine.findById(w.lineId);
    expect((await closedStateByLine([line!])).get(w.lineId)).toBe('short');
    await expect(createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 1 })).rejects.toMatchObject({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: expect.stringMatching(/desk is deciding who gets them/),
    });
  });

  it('Sales sees it with the buyers in the order they asked, and what the seller can send', async () => {
    const w = await shortPile();
    const mine = (await listShortPiles(everyone)).find((p) => p.pileId === w.pileId);
    expect(mine).toMatchObject({ canSend: 10, asked: 15 });
    expect(mine!.requests.map((r) => r.boxes)).toEqual([6, 5, 4]);
    expect(mine!.requests.map((r) => r.pileRequestId)).toEqual(w.requestIds);
    expect(mine!.requests.every((r) => r.firm.length > 0 && r.firm !== '-')).toBe(true);
  });
});

describe('Dividing a short pile (BR-134, BR-374)', () => {
  it("deals for those who got boxes, an ask for each buyer's leftover, the boxes held", async () => {
    const w = await shortPile();
    const result = await resolveShortPile(
      w.pileId,
      { allocations: split(w, [6, 4, 0]), reason: 'First come, first served.' },
      actor(),
      everyone,
    );
    expect(result).toEqual({ offeredBoxes: 10, backOnAskBoxes: 5, lineQty: 0 });

    // BR-378 — each buyer who got boxes is given his deal (his boxes, held 24 hours); no order yet.
    const offered = await PileRequest.find({ pileId: w.pileId }).sort({ requestedAt: 1 });
    expect(offered.map((r) => [r.offerState, r.offerQty])).toEqual([
      ['offered', 6],
      ['offered', 4],
      [null, null], // He got none: his boxes are an ask instead.
    ]);
    expect(offered[0]!.holdUntil!.getTime() - offered[0]!.offeredAt!.getTime()).toBe(
      24 * 3600 * 1000,
    );
    for (const buyer of w.buyers) expect(await boxesOrdered(buyer.docId)).toBe(0);

    // What was asked for and not given is open as an ask, so Purchase finds another seller.
    expect(await Ask.countDocuments({ buyerId: w.buyers[0]!.docId })).toBe(0);
    expect(await Ask.findOne({ buyerId: w.buyers[1]!.docId })).toMatchObject({
      qty: 1,
      state: 'open',
    });
    expect(await Ask.findOne({ buyerId: w.buyers[2]!.docId })).toMatchObject({
      qty: 4,
      state: 'open',
    });

    expect(await Pile.findById(w.pileId)).toMatchObject({
      shortfall: true,
      shortfallResolvedAt: expect.any(Date),
    });
    const line = await ListingLine.findById(w.lineId);
    expect(line!.qty).toBe(0);
    expect((await closedStateByLine([line!])).get(w.lineId)).toBe('sold_out'); // All 10 are held.
    expect((await listShortPiles(everyone)).some((p) => p.pileId === w.pileId)).toBe(false);

    // Each buyer's call history says what he was offered.
    const calls = await CallLog.find({ buyerId: w.buyers[1]!.docId });
    expect(calls.map((c) => c.note)).toContain(
      'Short pile divided: offered 4 of 5 boxes; the other 1 are open as an ask.',
    );

    // The first takes his deal (an order for 6); the second walks away: his 4 go back on the line.
    await acceptOffer(String(offered[0]!._id), w.buyers[0]!.docId);
    expect(await boxesOrdered(w.buyers[0]!.docId)).toBe(6);
    await declineOffer(String(offered[1]!._id), w.buyers[1]!.docId);
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(4);
    expect(await boxesOrdered(w.buyers[1]!.docId)).toBe(0);
  });

  it('giving less than the seller can send leaves the rest on the line, open to requests again', async () => {
    const w = await shortPile();
    await resolveShortPile(
      w.pileId,
      { allocations: split(w, [4, 3, 0]), reason: 'Two regulars first.' },
      actor(),
      everyone,
    );
    const line = await ListingLine.findById(w.lineId);
    expect(line!.qty).toBe(3);
    expect((await closedStateByLine([line!])).get(w.lineId)).toBeNull();
    const next = await createPileRequest(w.buyers[2]!.cp, w.lineId, { qty: 2 });
    expect(next.pileId).not.toBe(w.pileId);
  });

  it('dividing it twice is refused; a pile that is not short has nothing to divide', async () => {
    const w = await shortPile();
    const body = { allocations: split(w, [6, 4, 0]), reason: 'Once.' };
    await resolveShortPile(w.pileId, body, actor(), everyone);
    await expect(resolveShortPile(w.pileId, body, actor(), everyone)).rejects.toMatchObject({
      code: 'PILE_ALREADY_DECIDED',
    });
    // The deals are not given twice.
    expect(await PileRequest.countDocuments({ pileId: w.pileId, offerState: 'offered' })).toBe(2);

    const full = await shortPile(10, 15); // The seller can send all 15: no shortfall.
    const all = { allocations: split(full, [6, 5, 4]), reason: 'x' };
    await expect(resolveShortPile(full.pileId, all, actor(), everyone)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      messageEn: expect.stringMatching(/not short/),
    });
  });
});

describe('Refusals and scope (BR-134)', () => {
  it('refuses a division that is not fair, and changes nothing', async () => {
    const w = await shortPile();
    const attempt = (allocations: Array<{ pileRequestId: string; boxes: number }>) =>
      resolveShortPile(w.pileId, { allocations, reason: 'x' }, actor(), everyone);

    // 11 boxes is more than the 10 he can send; 7 is more than the 6 asked for.
    await expect(attempt(split(w, [6, 5, 0]))).rejects.toMatchObject({
      messageEn: expect.stringMatching(/more than that/),
    });
    await expect(attempt(split(w, [7, 3, 0]))).rejects.toMatchObject({
      messageEn: expect.stringMatching(/up to the 6/),
    });
    await expect(attempt(split(w, [-1, 3, 0]))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(attempt(split(w, [2.5, 3, 0]))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(attempt(split(w, [6, 4, 0]).slice(0, 2))).rejects.toMatchObject({
      messageEn: expect.stringMatching(/every buyer on the pile/),
    });
    const dup = split(w, [6, 4, 0]);
    dup[2] = { ...dup[0]! };
    await expect(attempt(dup)).rejects.toMatchObject({
      messageEn: expect.stringMatching(/listed twice/),
    });

    expect(await So.countDocuments({ pileRequestId: { $in: w.requestIds } })).toBe(0);
    expect(await Pile.findById(w.pileId)).toMatchObject({ shortfallResolvedAt: null });
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(10);
  });

  it("a pile with a buyer outside the caller's book is not shown, and he cannot divide it", async () => {
    const w = await shortPile();
    const notThird: Visibility = {
      all: false,
      allowsProfile: (id) => id !== w.buyers[2]!.docId,
      allowsCounterparty: () => true,
    };
    expect((await listShortPiles(notThird)).some((p) => p.pileId === w.pileId)).toBe(false);
    const body = { allocations: split(w, [6, 4, 0]), reason: 'x' };
    await expect(resolveShortPile(w.pileId, body, actor(), notThird)).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE',
    });
    expect(await So.countDocuments({ pileRequestId: { $in: w.requestIds } })).toBe(0);
  });
});

describe('The Sales route (BR-134)', () => {
  it('Sales lists and divides it; Purchase may not; a missing key or reason is refused', async () => {
    const w = await shortPile();
    const listed = await request(app)
      .get('/api/v1/staff/sales/short-piles')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((p: { pileId: string }) => p.pileId === w.pileId)).toBe(true);

    const url = `/api/v1/staff/sales/short-piles/${w.pileId}/resolve`;
    const body = { allocations: split(w, [6, 4, 0]), reason: 'First come, first served.' };
    const post = (token: string, key: string | null, payload: object) => {
      const r = request(app).post(url).set('Authorization', `Bearer ${token}`);
      return (key ? r.set('Idempotency-Key', key) : r).send(payload);
    };
    expect((await post(purchase.token, randomUUID(), body)).status).toBe(403);
    expect((await post(sales.token, null, body)).status).toBe(400);
    expect((await post(sales.token, randomUUID(), { ...body, reason: '  ' })).status).toBe(400);

    const done = await post(sales.token, randomUUID(), body);
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({ offeredBoxes: 10, backOnAskBoxes: 5, lineQty: 0 });
  });
});
