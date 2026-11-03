import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Quote } from '../src/models/Quote.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { So } from '../src/models/So.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import * as demandService from '../src/modules/demand/demand.service.js';
const { listMyAsks } = demandService;
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { cheapestOfferOnHisBoard } from '../src/modules/proxy/proxy.wantsIt.js';
import {
  getAskSellerStates,
  getActiveDemandList,
} from '../src/modules/desk/purchase/purchase.service.js';
import { getBuyerFile } from '../src/modules/desk/sales/sales.buyers.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * 2 Nov — BR-136 (sequential piles) and BR-127/BR-128 (a split fill): a listing line takes the next
 * group of requests once the last was confirmed and its orders made, and a quote for fewer boxes
 * than he asked for leaves the rest of the ask open.
 */
const app = createApp();

interface World {
  tehsil: string;
  skuId: string;
  productId: string;
  sellerCp: string;
  sellerDocId: string;
  buyers: Array<{ docId: string; cp: string }>;
}

let admin: { token: string; employeeId: string };
let sales: { token: string; employeeId: string };
let purchase: { token: string; employeeId: string };

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  sales = await staffToken(app, 'sales');
  purchase = await staffToken(app, 'purchase');
}, 60000);

async function seedWorld(buyerCount = 1): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const seller = await Seller.findById(sellerDocId);
  const sku = await Sku.findById(skuId);
  const buyers: World['buyers'] = [];
  for (let i = 0; i < buyerCount; i += 1) {
    const docId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const buyer = await Buyer.findById(docId);
    buyers.push({ docId, cp: String(buyer!.counterpartyId) });
  }
  return {
    tehsil,
    skuId,
    productId: String(sku!.productId),
    sellerCp: String(seller!.counterpartyId),
    sellerDocId,
    buyers,
  };
}

async function listLine(w: World, qty = 30, skuId = w.skuId, ratePaise = 40000) {
  await createListing(w.sellerCp, {
    productId: String((await Sku.findById(skuId))!.productId),
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '48h',
        provenance: 'company',
        qty,
      },
    ],
  } as never);
  return String((await ListingLine.findOne({ skuId }))!._id);
}

const confirmAndRun = async (w: World, pileId: string, canSendBoxes: number) => {
  await demandService.confirmPile(
    w.sellerCp,
    pileId,
    { canSendBoxes, expiryExact: '06/2028' },
    randomUUID(),
  );
  await runConfirmPileFanout(pileId);
};

describe('Sequential piles — a line takes the next group after the last is done (BR-136)', () => {
  it('a confirmed group with its orders made: the next request opens a new group', async () => {
    const w = await seedWorld(2);
    const lineId = await listLine(w, 30);
    const first = await createPileRequest(w.buyers[0]!.cp, lineId, { qty: 10 });
    await confirmAndRun(w, first.pileId, 10);
    expect((await ListingLine.findById(lineId))!.qty).toBe(20);

    const second = await createPileRequest(w.buyers[1]!.cp, lineId, { qty: 5 });
    expect(second.pileId).not.toBe(first.pileId);
    const piles = await Pile.find({ listingLineId: lineId }).sort({ openedAt: 1 });
    expect(piles.map((p) => p.decision)).toEqual(['confirmed', null]);
    expect(String(piles[1]!._id)).toBe(second.pileId);
  });

  it('requests while a group is open join it — one open group per line', async () => {
    const w = await seedWorld(2);
    const lineId = await listLine(w, 30);
    const a = await createPileRequest(w.buyers[0]!.cp, lineId, { qty: 3 });
    const b = await createPileRequest(w.buyers[1]!.cp, lineId, { qty: 4 });
    expect(b.pileId).toBe(a.pileId);
    expect(await PileRequest.countDocuments({ pileId: a.pileId })).toBe(2);
    expect(await Pile.countDocuments({ listingLineId: lineId })).toBe(1);
  });

  it('two requests racing to open the next group end up in the one group', async () => {
    const w = await seedWorld(3);
    const lineId = await listLine(w, 40);
    const first = await createPileRequest(w.buyers[0]!.cp, lineId, { qty: 5 });
    await confirmAndRun(w, first.pileId, 5);
    const [x, y] = await Promise.all([
      createPileRequest(w.buyers[1]!.cp, lineId, { qty: 2 }),
      createPileRequest(w.buyers[2]!.cp, lineId, { qty: 3 }),
    ]);
    expect(x.pileId).toBe(y.pileId);
    expect(await Pile.countDocuments({ listingLineId: lineId, decision: null })).toBe(1);
  });

  it('while the last confirmation is still being processed, or revised, declined or sold out: closed, and says why', async () => {
    const w = await seedWorld(2);
    const lineId = await listLine(w, 10);
    const first = await createPileRequest(w.buyers[0]!.cp, lineId, { qty: 10 });

    // Confirmed, orders not made yet (the five-second undo window).
    await demandService.confirmPile(
      w.sellerCp,
      first.pileId,
      { canSendBoxes: 10, expiryExact: '06/2028' },
      randomUUID(),
    );
    await expect(createPileRequest(w.buyers[1]!.cp, lineId, { qty: 1 })).rejects.toMatchObject({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: expect.stringMatching(/still processing/),
    });

    // Orders made, but all 10 boxes went: sold out.
    await runConfirmPileFanout(first.pileId);
    await expect(createPileRequest(w.buyers[1]!.cp, lineId, { qty: 1 })).rejects.toMatchObject({
      messageEn: 'This offer is sold out.',
    });

    // Revised and declined lines stay closed until someone acts on them.
    for (const [decision, text] of [
      ['requoted', /revised this offer/],
      ['declined', /declined this offer/],
    ] as const) {
      await ListingLine.updateOne({ _id: lineId }, { qty: 20 });
      await Pile.updateOne({ _id: first.pileId }, { decision, executedAt: null });
      await expect(createPileRequest(w.buyers[1]!.cp, lineId, { qty: 1 })).rejects.toMatchObject({
        code: 'PILE_ALREADY_DECIDED',
        messageEn: expect.stringMatching(text),
      });
    }
  });

  it('"Log a buyer call" skips an offer that takes no more requests, for the next one', async () => {
    const w = await seedWorld(1);
    const cheapSku = await createTestSku('Medium');
    // Same product is needed so both are one product's offers: list two packs of one product.
    const sku = await Sku.findById(w.skuId);
    const otherPack = await Sku.create({
      productId: sku!.productId,
      packLabel: '2 LTR',
      packSize: 2,
      baseUnit: 'LTR',
      unitsPerBox: 10,
    });
    void cheapSku;
    const cheapLine = await listLine(w, 20, w.skuId, 30000);
    const dearLine = await listLine(w, 20, String(otherPack._id), 45000);
    const wanted = { productId: w.productId, allPacks: true };
    expect(await cheapestOfferOnHisBoard(w.buyers[0]!.cp, wanted)).toBe(cheapLine);

    // The cheap one is declined by the seller: the next cheapest is the pick.
    const req = await createPileRequest(w.buyers[0]!.cp, cheapLine, { qty: 2 });
    await Pile.updateOne({ _id: req.pileId }, { decision: 'declined' });
    expect(await cheapestOfferOnHisBoard(w.buyers[0]!.cp, wanted)).toBe(dearLine);
    // With every offer closed there is nothing to put him on: an ask.
    const req2 = await createPileRequest(w.buyers[0]!.cp, dearLine, { qty: 2 });
    await Pile.updateOne({ _id: req2.pileId }, { decision: 'declined' });
    expect(await cheapestOfferOnHisBoard(w.buyers[0]!.cp, wanted)).toBeNull();
  });
});

describe('A short fill leaves the rest of the ask open (BR-127, BR-128)', () => {
  async function askOf(w: World, qty: number) {
    const { askId } = await demandService.raiseAsk(w.buyers[0]!.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty,
      conditionRequirement: { expiryBand: 'over12' },
    });
    return askId;
  }
  async function sellerQuote(w: World, askId: string, qtyAvailable: number, rate = 40000) {
    // Each quote from a fresh seller, as the demand is worked one seller at a time.
    const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [w.tehsil]);
    const seller = await Seller.findById(sellerDocId);
    const { quoteId } = await demandService.postQuote(String(seller!.counterpartyId), askId, {
      ratePaiseForIndore: rate,
      qtyAvailable,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '2-5d',
      provenance: 'company',
      daysToIndore: 2,
    });
    return quoteId;
  }
  const accept = (w: World, askId: string, quoteIds: string[], keepRemainderOpen?: boolean) =>
    demandService.acceptAskFill(
      w.buyers[0]!.cp,
      askId,
      {
        option: 'partial',
        quoteIds,
        ...(keepRemainderOpen === undefined ? {} : { keepRemainderOpen }),
      },
      randomUUID(),
    );

  it('100 asked: 10, then 50, then 40 — the ask stays open at what is left until it is full', async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 100);

    const q1 = await sellerQuote(w, askId, 10);
    const first = await accept(w, askId, [q1]);
    expect(first).toMatchObject({ filledBoxes: 10, remainingBoxes: 90 });
    expect(await Ask.findById(askId)).toMatchObject({ qty: 90, filledQty: 10, state: 'open' });
    expect((await So.findById(first.soIds[0]))!.askId?.toString()).toBe(askId);

    const q2 = await sellerQuote(w, askId, 50);
    // The gap check measures against what is left, not the original 100.
    expect((await Quote.findById(q2))!.gapCodes).toContain('short_on_quantity');
    const second = await accept(w, askId, [q2]);
    expect(second).toMatchObject({ filledBoxes: 50, remainingBoxes: 40 });
    expect(await Ask.findById(askId)).toMatchObject({ qty: 40, filledQty: 60, state: 'open' });

    const q3 = await sellerQuote(w, askId, 40);
    expect((await Quote.findById(q3))!.gapCodes ?? []).not.toContain('short_on_quantity');
    const third = await accept(w, askId, [q3]);
    expect(third).toMatchObject({ filledBoxes: 40, remainingBoxes: 0 });
    expect(await Ask.findById(askId)).toMatchObject({ filledQty: 100, state: 'converted' });

    const orders = await So.find({ askId });
    expect(orders.map((o) => o.state)).toHaveLength(3);
    expect(await So.countDocuments({ askId })).toBe(3);
  });

  it('never over-fills: a quote bigger than what is left is trimmed to it', async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 40);
    const q = await sellerQuote(w, askId, 50);
    const result = await accept(w, askId, [q]);
    expect(result).toMatchObject({ filledBoxes: 40, remainingBoxes: 0 });
    expect(await Ask.findById(askId)).toMatchObject({ filledQty: 40, state: 'converted' });
  });

  it('several quotes taken together fill it in one go, the dearest trimmed if they add up to more', async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 100);
    const qs = [
      await sellerQuote(w, askId, 10, 41000),
      await sellerQuote(w, askId, 50, 40000),
      await sellerQuote(w, askId, 60, 42000),
    ];
    const result = await accept(w, askId, qs);
    // Cheapest first: 50 + 10 + the dearest trimmed to the 40 still wanted.
    expect(result).toMatchObject({ filledBoxes: 100, remainingBoxes: 0 });
    expect(await So.countDocuments({ askId })).toBe(3);
    expect(await Ask.findById(askId)).toMatchObject({ state: 'converted', filledQty: 100 });
  });

  it("a short fill keeps the other sellers' live quotes live; closing it ranks them as before", async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 100);
    const taken = await sellerQuote(w, askId, 10);
    const other = await sellerQuote(w, askId, 60, 43000);
    await accept(w, askId, [taken]);
    expect((await Quote.findById(other))!.status).toBe('live');
    expect((await Ask.findById(askId))!.state).toBe('quoted');

    // The buyer closes it instead: what was ordered stands, the rest is ranked and lost.
    const w2 = await seedWorld();
    const ask2 = await askOf(w2, 100);
    const t2 = await sellerQuote(w2, ask2, 10);
    const o2 = await sellerQuote(w2, ask2, 60, 43000);
    const closed = await accept(w2, ask2, [t2], false);
    expect(closed).toMatchObject({ filledBoxes: 10, remainingBoxes: 90 });
    expect(await Ask.findById(ask2)).toMatchObject({ state: 'converted', filledQty: 10 });
    expect((await Quote.findById(o2))!.status).toBe('lost');
  });

  it('refuses to take quotes on an ask that is no longer open', async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 10);
    const q = await sellerQuote(w, askId, 10);
    await Ask.updateOne({ _id: askId }, { state: 'withdrawn' });
    await expect(accept(w, askId, [q])).rejects.toMatchObject({ code: 'ENQUIRY_NOT_OPEN' });
    expect(await So.countDocuments({ askId })).toBe(0);
  });

  it('every screen sees it: Demand, the seller rows, the buyer file and his own My asks', async () => {
    const w = await seedWorld();
    const askId = await askOf(w, 100);

    // Nothing is listed and nobody has quoted: it waits on Purchase to find a seller.
    let file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.openAsks.find((a) => a.askId === askId)).toMatchObject({
      qty: 100,
      filledQty: 0,
      waitingOnPurchase: true,
    });

    const q1 = await sellerQuote(w, askId, 10);
    // A live quote moves the ask on to "Rate given": it is no longer in "He asked".
    file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.openAsks.find((a) => a.askId === askId)).toBeUndefined();
    expect(file.liveQuotes.some((q) => q.askId === askId)).toBe(true);

    // The seller row says by how much it is short.
    const states = await getAskSellerStates(askId);
    expect(states.find((s) => s.state === 'quoted')).toMatchObject({
      qtyAvailable: 10,
      askQty: 100,
    });
    expect(states.find((s) => s.state === 'quoted')!.gapCodes).toContain('short_on_quantity');

    await accept(w, askId, [q1]);
    const demand = (await getActiveDemandList({})).find((d) => d.askId === askId)!;
    expect(demand).toMatchObject({ qty: 90, filledQty: 10 });
    const mine = (await listMyAsks(w.buyers[0]!.cp)).find((a) => a.askId === askId)!;
    expect(mine).toMatchObject({ qty: 90, filledQty: 10 });
    file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.openAsks.find((a) => a.askId === askId)).toMatchObject({
      qty: 90,
      filledQty: 10,
      waitingOnPurchase: true, // Its quote was taken: nobody has quoted the rest yet.
    });
  });

  it('an ask for something that is listed is not waiting on Purchase', async () => {
    const w = await seedWorld();
    await listLine(w, 30);
    const askId = await askOf(w, 5);
    const file = await getBuyerFile(w.buyers[0]!.docId);
    expect(file.openAsks.find((a) => a.askId === askId)!.waitingOnPurchase).toBe(false);
  });
});
