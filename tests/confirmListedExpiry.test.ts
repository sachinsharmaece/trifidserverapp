import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pile } from '../src/models/Pile.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { getPilesAwaitingDecision } from '../src/modules/desk/purchase/purchase.service.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * 2 Nov — BR-102: the exact expiry is fixed when the pile is confirmed, but where the listing was
 * entered with one, confirming does not ask for it again. The year is the least that counts; the
 * month is optional. Batch is still only for My stock (BR-105).
 */
const app = createApp();
const year = new Date().getFullYear();

let admin: { token: string; employeeId: string };
let sales: { token: string; employeeId: string };
let purchase: { token: string; employeeId: string };

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  sales = await staffToken(app, 'sales');
  purchase = await staffToken(app, 'purchase');
}, 60000);

/** A line of 25 boxes (optionally with an expiry and provenance), and one pile of 10 on it. */
async function pileOn(line: { expiryExact?: string; provenance?: 'company' | 'auth' } = {}) {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyerDocId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
  const buyerCp = String((await Buyer.findById(buyerDocId))!.counterpartyId);
  const provenance = line.provenance ?? 'company';
  await createListing(sellerCp, {
    productId: String((await Sku.findById(skuId))!.productId),
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise: 40000,
        expiryBand: 'over12',
        ...(line.expiryExact ? { expiryExact: line.expiryExact } : {}),
        moqExact: 1,
        deliveryBand: '48h',
        provenance,
        ...(provenance === 'auth' ? { batch: 'B-1' } : {}),
        qty: 25,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  const { pileId } = await createPileRequest(buyerCp, lineId, { qty: 10 });
  const confirm = (input: { canSendBoxes?: number; expiryExact?: string; batch?: string }) =>
    demandService.confirmPile(sellerCp, pileId, { canSendBoxes: 10, ...input }, randomUUID());
  return { lineId, pileId, sellerCp, confirm };
}

describe('Confirming a pile on a listing that carries an expiry', () => {
  it('needs none typed: the listed month and year stand, and are fixed for the buyer to see', async () => {
    const w = await pileOn({ expiryExact: `06/${year + 3}` });
    await w.confirm({});
    expect(await Pile.findById(w.pileId)).toMatchObject({ expiryExact: `06/${year + 3}` });
    expect(await ListingLine.findById(w.lineId)).toMatchObject({
      expiryExact: `06/${year + 3}`,
      expiryFixed: true,
    });
  });

  it('a year alone is enough, listed or given', async () => {
    const listed = await pileOn({ expiryExact: String(year + 3) });
    await listed.confirm({});
    expect(await Pile.findById(listed.pileId)).toMatchObject({ expiryExact: String(year + 3) });

    const given = await pileOn();
    await given.confirm({ expiryExact: String(year + 2) });
    expect(await Pile.findById(given.pileId)).toMatchObject({ expiryExact: String(year + 2) });
  });

  it('what he gives now wins over the listed one', async () => {
    const w = await pileOn({ expiryExact: `06/${year + 3}` });
    await w.confirm({ expiryExact: `09/${year + 3}` });
    expect(await Pile.findById(w.pileId)).toMatchObject({ expiryExact: `09/${year + 3}` });
    expect((await ListingLine.findById(w.lineId))!.expiryExact).toBe(`09/${year + 3}`);
  });

  it('with none listed and none given it asks for the year, and confirms nothing', async () => {
    const w = await pileOn();
    await expect(w.confirm({})).rejects.toMatchObject({
      code: 'EXPIRY_REQUIRED',
      messageEn: expect.stringMatching(/at least the year/),
    });
    expect(await Pile.findById(w.pileId)).toMatchObject({ decision: null });
  });

  it('My stock still needs its batch, whatever the expiry', async () => {
    const w = await pileOn({ expiryExact: `06/${year + 3}`, provenance: 'auth' });
    await expect(w.confirm({})).rejects.toMatchObject({ code: 'BATCH_REQUIRED' });
    await w.confirm({ batch: 'B-1' });
    expect(await Pile.findById(w.pileId)).toMatchObject({ decision: 'confirmed', batch: 'B-1' });
  });
});

describe('What Purchase sees, and sends, for a pile', () => {
  it('each waiting pile carries what he listed: boxes, expiry and provenance', async () => {
    const w = await pileOn({ expiryExact: `06/${year + 3}`, provenance: 'auth' });
    const row = (await getPilesAwaitingDecision()).find((p) => p.pileId === w.pileId);
    expect(row).toMatchObject({
      boxes: 10,
      lineQty: 25,
      listedExpiry: `06/${year + 3}`,
      provenance: 'auth',
    });
    const bare = await pileOn();
    const bareRow = (await getPilesAwaitingDecision()).find((p) => p.pileId === bare.pileId);
    expect(bareRow).toMatchObject({ listedExpiry: null, provenance: 'company' });
  });

  it('the call route confirms with a year alone or with nothing, and says what is wrong with a bad one', async () => {
    const w = await pileOn({ expiryExact: `06/${year + 3}` });
    const url = `/api/v1/staff/proxy/seller/confirmations/${w.pileId}/confirm`;
    const post = (body: object) =>
      request(app)
        .post(url)
        .set('Authorization', `Bearer ${purchase.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ sellerCounterpartyId: w.sellerCp, canSendBoxes: 10, callNote: 'ok', ...body });

    const bad = await post({ expiryExact: '13/2029' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain(
      'Give the expiry as a year (2027) or a month and year (03/2027).',
    );
    expect(await Pile.findById(w.pileId)).toMatchObject({ decision: null });

    const done = await post({}); // No expiry typed: the listed one stands.
    expect(done.status).toBe(201);
    expect(await Pile.findById(w.pileId)).toMatchObject({ expiryExact: `06/${year + 3}` });
  });
});

describe('Listing with a year-only expiry', () => {
  it('is accepted from the desk and kept as given', async () => {
    const tehsil = await createTehsil();
    const skuId = await createTestSku('Medium');
    const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
    const productId = String((await Sku.findById(skuId))!.productId);
    const body = (expiryExact: string) => ({
      sellerCounterpartyId: sellerCp,
      productId,
      scopeType: 'my_area',
      lines: [
        {
          skuId,
          ratePaise: 40000,
          expiryBand: 'over12',
          expiryExact,
          deliveryBand: '48h',
          provenance: 'company',
          qty: 20,
        },
      ],
      callNote: 'note',
    });
    const send = (expiryExact: string) =>
      request(app)
        .post('/api/v1/staff/proxy/seller/listings')
        .set('Authorization', `Bearer ${purchase.token}`)
        .send(body(expiryExact));

    const ok = await send(String(year + 2));
    expect(ok.status).toBe(201);
    expect((await ListingLine.findById(ok.body.data.lineIds[0]))!.expiryExact).toBe(
      String(year + 2),
    );
    expect((await send('2027-03')).status).toBe(400); // Neither a year nor month and year.
  });

  it("the seller's own listing still meets the six-month floor, counting a year alone to December", async () => {
    const w = await pileOn(); // Just to get a seller and sku.
    const line = (await ListingLine.findById(w.lineId))!;
    const seller = await Seller.findOne({ counterpartyId: w.sellerCp });
    const listing = { productId: String((await Sku.findById(line.skuId))!.productId) };
    const make = (expiryExact: string, rate: number) =>
      createListing(String(seller!.counterpartyId), {
        ...listing,
        scopeType: 'my_area',
        lines: [
          {
            skuId: String(line.skuId),
            ratePaise: rate,
            expiryBand: 'under12',
            expiryExact,
            deliveryBand: '48h',
            provenance: 'company',
            qty: 5,
          },
        ],
      } as never);
    // This year alone runs to December: under six months from now (November), refused.
    await expect(make(String(year), 41000)).rejects.toMatchObject({ code: 'SHELF_LIFE_FLOOR' });
    // Next year is far enough.
    await expect(make(String(year + 1), 42000)).resolves.toBeDefined();
  });
});
