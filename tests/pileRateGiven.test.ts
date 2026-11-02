import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { Buyer } from '../src/models/Buyer.js';
import { CallLog } from '../src/models/CallLog.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { So } from '../src/models/So.js';
import { SoLine } from '../src/models/SoLine.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import { runPileOfferExpiry } from '../src/modules/clocks/clocks.jobs.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { getBuyerFile } from '../src/modules/desk/sales/sales.buyers.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';
import { acceptOffer, declineOffer } from './pileOfferHelpers.js';

/**
 * 2 Nov — BR-378: when the seller confirms a pile, each buyer on it is given his deal and it is his
 * to take or walk away from inside 24 hours. His order is made when he accepts.
 */
const app = createApp();
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

/** A line of 30 boxes; two buyers ask 10 and 5; the seller confirms the 15 and the fan-out runs. */
async function confirmedPile(): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyers: World['buyers'] = [];
  for (let i = 0; i < 2; i += 1) {
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
        qty: 30,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  let pileId = '';
  for (const [i, qty] of [10, 5].entries()) {
    pileId = (await createPileRequest(buyers[i]!.cp, lineId, { qty })).pileId;
  }
  await demandService.confirmPile(
    sellerCp,
    pileId,
    { canSendBoxes: 15, expiryExact: '2029' },
    randomUUID(),
  );
  await runConfirmPileFanout(pileId);
  const requests = await PileRequest.find({ pileId }).sort({ requestedAt: 1 });
  return { lineId, pileId, buyers, requestIds: requests.map((r) => String(r._id)) };
}

const boxesOrdered = async (buyerDocId: string): Promise<number> => {
  const sos = await So.find({ buyerId: buyerDocId });
  const lines = await SoLine.find({ soId: { $in: sos.map((s) => s._id) } });
  return lines.reduce((sum, l) => sum + l.boxes, 0);
};
const buyerToken = (cp: string) =>
  signAccessToken({
    sub: cp,
    actorType: 'counterparty',
    counterpartyId: cp,
    roles: [],
    permissions: [],
    status: 'active',
  });

describe('Confirming a pile gives each buyer his deal (BR-378)', () => {
  it('no order yet: his boxes held 24 hours off the listing, and his rate is ready', async () => {
    const w = await confirmedPile();
    expect(await So.countDocuments({ pileRequestId: { $in: w.requestIds } })).toBe(0);
    const requests = await PileRequest.find({ pileId: w.pileId }).sort({ requestedAt: 1 });
    expect(requests.map((r) => [r.offerState, r.offerQty])).toEqual([
      ['offered', 10],
      ['offered', 5],
    ]);
    const hold = requests[0]!.holdUntil!.getTime() - requests[0]!.offeredAt!.getTime();
    expect(hold).toBe(24 * 3600 * 1000);
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(15); // 30 less the 15 held.

    // The existing "your rate is ready" message, once per buyer.
    for (const [i, buyer] of w.buyers.entries()) {
      const rows = await NotificationOutbox.find({
        counterpartyId: buyer.cp,
        templateKey: 'rate_ready',
      });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.params as { askId: string }).askId).toBe(w.requestIds[i]);
    }
  });

  it('shows on Sales buyer file under Rate given, with his own rate and the confirmed expiry', async () => {
    const w = await confirmedPile();
    const file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.waitingOnSeller).toHaveLength(0); // The seller has answered.
    expect(file.pileOffers).toHaveLength(1);
    expect(file.pileOffers[0]).toMatchObject({
      requestId: w.requestIds[0],
      boxes: 10,
      askedBoxes: 10,
      expiryExact: '2029',
      ratePaise: expect.any(Number),
    });
    expect(file.pileOffers[0]!.ratePaise).toBeGreaterThan(40000); // Seller net plus his margin.
    expect(file.funnel.find((s) => s.key === 'rate_held')).toMatchObject({ count: 1 });
    expect(file.ordersByStage.paymentPending).toHaveLength(0);
  });
});

describe('Taking or walking away from the deal', () => {
  it('accepting makes his order for the boxes offered, with its payment window running', async () => {
    const w = await confirmedPile();
    const { soId } = await acceptOffer(w.requestIds[0]!, w.buyers[0]!.docId);
    expect(await boxesOrdered(w.buyers[0]!.docId)).toBe(10);
    expect(await So.findById(soId)).toMatchObject({ state: 'awaiting_payment' });
    expect(String((await So.findById(soId))!.pileRequestId)).toBe(w.requestIds[0]);
    expect((await PileRequest.findById(w.requestIds[0]))!.offerState).toBe('ordered');
    expect(await boxesOrdered(w.buyers[1]!.docId)).toBe(0); // His neighbour's is untouched.

    const file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.pileOffers).toHaveLength(0);
    expect(file.ordersByStage.paymentPending).toHaveLength(1);

    await expect(acceptOffer(w.requestIds[0]!, w.buyers[0]!.docId)).rejects.toMatchObject({
      code: 'PILE_OFFER_CLOSED',
      messageEn: 'This deal has already been ordered.',
    });
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(15); // Still held for the order.
  });

  it('walking away makes no order and gives his boxes back; it cannot then be taken', async () => {
    const w = await confirmedPile();
    await declineOffer(w.requestIds[1]!, w.buyers[1]!.docId);
    expect((await PileRequest.findById(w.requestIds[1]))!.offerState).toBe('declined');
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(20); // 15 + his 5.
    expect(await boxesOrdered(w.buyers[1]!.docId)).toBe(0);
    await expect(acceptOffer(w.requestIds[1]!, w.buyers[1]!.docId)).rejects.toMatchObject({
      code: 'PILE_OFFER_CLOSED',
      messageEn: 'This deal was walked away from.',
    });
    await expect(declineOffer(w.requestIds[1]!, w.buyers[1]!.docId)).rejects.toMatchObject({
      code: 'PILE_OFFER_CLOSED',
    });
  });

  it("a buyer cannot take or leave someone else's deal", async () => {
    const w = await confirmedPile();
    await expect(acceptOffer(w.requestIds[0]!, w.buyers[1]!.docId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await PileRequest.findById(w.requestIds[0]))!.offerState).toBe('offered');
  });
});

describe('The 24-hour hold', () => {
  it('past it the deal cannot be taken, and its boxes go back on the listing', async () => {
    const w = await confirmedPile();
    await PileRequest.updateOne(
      { _id: w.requestIds[0] },
      { holdUntil: new Date(Date.now() - 60_000) },
    );
    await expect(acceptOffer(w.requestIds[0]!, w.buyers[0]!.docId)).rejects.toMatchObject({
      code: 'PILE_OFFER_CLOSED',
      messageEn: 'The 24-hour hold on this deal has run out.',
    });
    expect((await PileRequest.findById(w.requestIds[0]))!.offerState).toBe('expired');
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(25); // 15 + his 10.
    expect(await boxesOrdered(w.buyers[0]!.docId)).toBe(0);
  });

  it('the clock releases every deal past its hold, and only those', async () => {
    const w = await confirmedPile();
    await PileRequest.updateOne(
      { _id: w.requestIds[0] },
      { holdUntil: new Date(Date.now() - 60_000) },
    );
    const { released } = await runPileOfferExpiry();
    expect(released).toBeGreaterThanOrEqual(1);
    expect((await PileRequest.findById(w.requestIds[0]))!.offerState).toBe('expired');
    expect((await PileRequest.findById(w.requestIds[1]))!.offerState).toBe('offered');
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(25);
    expect((await runPileOfferExpiry()).released).toBe(0); // Nothing is released twice.
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(25);
    expect((await getBuyerFile(w.buyers[0]!.docId)).pileOffers).toHaveLength(0);
  });
});

describe('The routes (BR-378)', () => {
  it('a buyer sees only his own deals, and takes one with an Idempotency-Key', async () => {
    const w = await confirmedPile();
    const token = await buyerToken(w.buyers[0]!.cp);
    const listed = await request(app)
      .get('/api/v1/pile-offers')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((o: { requestId: string }) => o.requestId)).toEqual([
      w.requestIds[0],
    ]);

    const url = `/api/v1/pile-offers/${w.requestIds[0]}/accept`;
    const noKey = await request(app).post(url).set('Authorization', `Bearer ${token}`);
    expect(noKey.status).toBe(400);
    const done = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());
    expect(done.status).toBe(201);
    expect(done.body.data).toMatchObject({ boxes: 10 });
    expect(await boxesOrdered(w.buyers[0]!.docId)).toBe(10);

    const other = await buyerToken(w.buyers[1]!.cp);
    const stolen = await request(app)
      .post(`/api/v1/pile-offers/${w.requestIds[0]}/decline`)
      .set('Authorization', `Bearer ${other}`)
      .set('Idempotency-Key', randomUUID());
    expect(stolen.status).toBe(404);
  });

  it('Sales takes it, or walks away, on his word, with a call note; Purchase may not', async () => {
    const w = await confirmedPile();
    const accept = (id: string, token: string, body: object) =>
      request(app)
        .post(`/api/v1/staff/proxy/buyer/pile-offers/${id}/accept`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const body = { buyerCounterpartyId: w.buyers[0]!.cp, callNote: 'He said yes on the call.' };

    expect((await accept(w.requestIds[0]!, purchase.token, body)).status).toBe(403);
    expect((await accept(w.requestIds[0]!, sales.token, { ...body, callNote: '' })).status).toBe(
      400,
    );

    const done = await accept(w.requestIds[0]!, sales.token, body);
    expect(done.status).toBe(201);
    const so = await So.findById(done.body.data.soId);
    expect(so!.proxyLog.at(-1)).toMatchObject({
      action: 'accept_pile_offer',
      callNote: 'He said yes on the call.',
    });
    const calls = await CallLog.find({ buyerId: w.buyers[0]!.docId });
    expect(calls.map((c) => c.outcome)).toContain('placed_an_order');

    const away = await request(app)
      .post(`/api/v1/staff/proxy/buyer/pile-offers/${w.requestIds[1]}/decline`)
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ buyerCounterpartyId: w.buyers[1]!.cp, callNote: 'Does not want it now.' });
    expect(away.status).toBe(200);
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(20);
  });
});
