import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { CallLog } from '../src/models/CallLog.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Pile } from '../src/models/Pile.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { acceptAskFillSchema } from '../src/modules/demand/demand.validation.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import {
  proxyAcceptAskFillSchema,
  proxyPromotionDecisionSchema,
} from '../src/modules/proxy/proxy.validation.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import { withPileRequoteEnabled } from './requoteFlag.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * 3 Nov (My view sheet) — the call note is optional on the actions the desks named: a pile's
 * confirm / requote / decline, log a buyer call, a call-page update, "He wants it", advance an ask
 * and the promoted-fallback decision. Every other staff action keeps it mandatory. Purchase
 * confirming a pile on a call may also leave the expiry and the batch out.
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

/** A line of 25 boxes (no expiry listed) and one pile of 10 on it. */
async function pileOn(provenance: 'company' | 'auth' = 'company') {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyerDocId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
  const buyerCp = String((await Buyer.findById(buyerDocId))!.counterpartyId);
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
        provenance,
        ...(provenance === 'auth' ? { batch: 'B-1' } : {}),
        qty: 25,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  const { pileId } = await createPileRequest(buyerCp, lineId, { qty: 10 });
  return { tehsil, lineId, pileId, sellerCp, buyerDocId, buyerCp };
}

const sellerCall = (pileId: string, action: 'confirm' | 'requote' | 'decline', body: object) =>
  request(app)
    .post(`/api/v1/staff/proxy/seller/confirmations/${pileId}/${action}`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', randomUUID())
    .send(body);

describe('Confirmations — confirm, requote and decline without a note', () => {
  it('confirms a company-billed pile with no note and no expiry; nothing is fixed for the buyer', async () => {
    const w = await pileOn('company');
    const res = await sellerCall(w.pileId, 'confirm', {
      sellerCounterpartyId: w.sellerCp,
      canSendBoxes: 10,
    });
    expect(res.status).toBe(201);
    const pile = await Pile.findById(w.pileId);
    expect(pile).toMatchObject({ decision: 'confirmed', expiryExact: null, batch: null });
    expect(pile!.proxyLog[0]).toMatchObject({ action: 'confirm_pile', callNote: '' });
    expect(await ListingLine.findById(w.lineId)).toMatchObject({
      expiryExact: null,
      expiryFixed: false,
    });
  });

  it('confirms a My stock pile with no batch', async () => {
    const w = await pileOn('auth');
    const res = await sellerCall(w.pileId, 'confirm', {
      sellerCounterpartyId: w.sellerCp,
      canSendBoxes: 10,
    });
    expect(res.status).toBe(201);
    expect(await Pile.findById(w.pileId)).toMatchObject({ decision: 'confirmed', batch: null });
  });

  it('a typed expiry is still validated and still fixed', async () => {
    const w = await pileOn('company');
    const year = new Date().getFullYear() + 3;
    const bad = await sellerCall(w.pileId, 'confirm', {
      sellerCounterpartyId: w.sellerCp,
      canSendBoxes: 10,
      expiryExact: '13/2029',
    });
    expect(bad.status).toBe(400);
    const good = await sellerCall(w.pileId, 'confirm', {
      sellerCounterpartyId: w.sellerCp,
      canSendBoxes: 10,
      expiryExact: `06/${year}`,
    });
    expect(good.status).toBe(201);
    expect(await ListingLine.findById(w.lineId)).toMatchObject({
      expiryExact: `06/${year}`,
      expiryFixed: true,
    });
  });

  it('requotes and declines with no note', async () => {
    const a = await pileOn();
    const requote = await withPileRequoteEnabled(() =>
      sellerCall(a.pileId, 'requote', { sellerCounterpartyId: a.sellerCp }),
    );
    expect(requote.status).toBe(200);
    expect(await Pile.findById(a.pileId)).toMatchObject({ decision: 'requoted' });

    const b = await pileOn();
    const decline = await sellerCall(b.pileId, 'decline', { sellerCounterpartyId: b.sellerCp });
    expect(decline.status).toBe(200);
    expect(await Pile.findById(b.pileId)).toMatchObject({ decision: 'declined' });
  });
});

describe('Sales call page — notes are optional on the named forms', () => {
  it('Log a buyer call (one product or several) saves with no note, and the history row is empty', async () => {
    const w = await pileOn();
    const skuId = await createTestSku('Medium');
    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks/batch')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: w.buyerCp,
        lines: [{ skuId, qty: 3, conditionRequirement: { expiryBand: 'over12' } }],
      });
    expect(res.status).toBe(201);
    const single = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: w.buyerCp,
        skuId,
        qty: 2,
        conditionRequirement: { expiryBand: 'under12' },
      });
    expect(single.status).toBe(201);

    const history = await request(app)
      .get('/api/v1/staff/sales/calls')
      .query({ buyerId: w.buyerDocId })
      .set('Authorization', `Bearer ${sales.token}`);
    expect(history.status).toBe(200);
    expect(history.body.data.length).toBeGreaterThanOrEqual(2);
    expect(history.body.data.every((row: { note: string }) => row.note === '')).toBe(true);
  });

  it('Record an update saves with no note', async () => {
    const w = await pileOn();
    const res = await request(app)
      .post('/api/v1/staff/sales/calls')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerId: w.buyerDocId,
        kind: 'update_request',
        updateKind: 'mobile',
        updateValue: '9876543210',
      });
    expect(res.status).toBe(201);
    expect(await CallLog.findOne({ buyerId: w.buyerDocId, kind: 'update_request' })).toMatchObject({
      note: '',
    });
  });

  it('"He wants it" puts him on the offer with no note', async () => {
    const w = await pileOn();
    const other = await createApprovedBuyerAtTehsil(app, sales.token, w.tehsil, 'dealer');
    const otherCp = String((await Buyer.findById(other))!.counterpartyId);
    const res = await request(app)
      .post(`/api/v1/staff/proxy/buyer/listing-lines/${w.lineId}/wants-it`)
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ buyerCounterpartyId: otherCp, qty: 2 });
    expect(res.status).toBe(201);
  });

  it('advance an ask and the promoted-fallback decision take no note', () => {
    const fill = { buyerCounterpartyId: 'x', option: 'full' as const, quoteIds: ['q'] };
    expect(proxyAcceptAskFillSchema.safeParse(fill).success).toBe(true);
    expect(proxyAcceptAskFillSchema.parse(fill).callNote).toBe('');
    expect(proxyPromotionDecisionSchema.safeParse({ buyerCounterpartyId: 'x' }).success).toBe(true);
    // The buyer's own accept schema is untouched.
    expect(acceptAskFillSchema.safeParse({ option: 'full', quoteIds: ['q'] }).success).toBe(true);
  });

  it('declining an ask keeps its note mandatory — only the named actions were relaxed', async () => {
    const w = await pileOn();
    const skuId = await createTestSku('Medium');
    const ask = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: w.buyerCp,
        skuId,
        qty: 1,
        conditionRequirement: { expiryBand: 'over12' },
      });
    const decline = await request(app)
      .post(`/api/v1/staff/proxy/buyer/asks/${ask.body.data.askId}/decline`)
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ buyerCounterpartyId: w.buyerCp });
    expect(decline.status).toBe(400);
  });
});
