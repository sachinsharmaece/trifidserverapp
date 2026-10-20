import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Buyer } from '../src/models/Buyer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { StockHold } from '../src/models/StockHold.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

async function raiseSo() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('Medium');
  await seedMarginCell('Medium', 'Dealer', 0.05, admin.employeeId);
  const soRes = await request(app)
    .post('/api/v1/staff/so')
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      buyerId,
      sellerId,
      skuId,
      boxes: 10,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    });
  expect(soRes.status).toBe(201);
  const { soId } = soRes.body.data as { soId: string };
  return { soId, buyerId, sales, purchase };
}

async function payOrder(salesToken: string, soId: string): Promise<string> {
  const paid = await request(app)
    .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
    .set('Authorization', `Bearer ${salesToken}`)
    .set('Idempotency-Key', idemKey())
    .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
  expect(paid.status).toBe(201);
  return (paid.body.data as { poId: string }).poId;
}

const get = (token: string, path: string) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

describe('Purchase desk — Stock (the seller holds the stock until the buyer pays)', () => {
  it('lists an unpaid order, takes a 24-hour hold by default, then the seller confirms it', async () => {
    const { soId, buyerId, purchase } = await raiseSo();

    const before = await get(purchase.token, '/staff/purchase/stock');
    expect(before.status).toBe(200);
    const row = (before.body.data as Array<{ soId: string; hold: string }>).find(
      (r) => r.soId === soId,
    );
    expect(row?.hold).toBe('not_asked');

    // The desk's wall: no buyer identity and no rupee total in what Purchase reads.
    const buyer = (await Buyer.findById(buyerId))!;
    const counterparty = (await Counterparty.findById(buyer.counterpartyId))!;
    const text = JSON.stringify(before.body);
    expect(text).not.toContain(String(counterparty._id));
    expect(text).not.toContain(counterparty.firm ?? '\u0000');
    expect(text.toLowerCase()).not.toContain('totalpaise');

    const asked = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'Asked him to hold it till the buyer pays.' });
    expect(asked.status).toBe(201);
    const hold = (await StockHold.findOne({ soId }))!;
    expect(hold.holdHours).toBe(24);
    const hoursAhead = (hold.holdUntil.getTime() - Date.now()) / 3_600_000;
    expect(hoursAhead).toBeGreaterThan(23.9);
    expect(hoursAhead).toBeLessThanOrEqual(24);
    expect(hold.confirmedAt).toBeNull();

    const confirmed = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold/confirm`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'He said yes, holding it.' });
    expect(confirmed.status).toBe(200);
    const after = await get(purchase.token, '/staff/purchase/stock');
    expect(
      (after.body.data as Array<{ soId: string; hold: string }>).find((r) => r.soId === soId)?.hold,
    ).toBe('confirmed');

    // A different number of hours, and asking again, needs a fresh yes.
    const again = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ holdHours: 12, callNote: 'Shorter this time.' });
    expect(again.status).toBe(201);
    const reasked = (await StockHold.findOne({ soId }))!;
    expect(reasked.holdHours).toBe(12);
    expect(reasked.confirmedAt).toBeNull();
  });

  it('refuses a hold for an order that is already paid, and confirming without asking first', async () => {
    const { soId, sales, purchase } = await raiseSo();
    const early = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold/confirm`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'Nothing asked yet.' });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.status).toBeLessThan(500);

    await payOrder(sales.token, soId);
    const late = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'Too late.' });
    expect(late.status).toBe(409);
    // A paid order has left Stock.
    const queue = await get(purchase.token, '/staff/purchase/stock');
    expect((queue.body.data as Array<{ soId: string }>).some((r) => r.soId === soId)).toBe(false);
  });

  it('is closed to a role that cannot act for a seller', async () => {
    const { soId, sales } = await raiseSo();
    const res = await request(app)
      .post(`/api/v1/staff/purchase/stock/${soId}/hold`)
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ callNote: 'Not Sales to ask.' });
    expect(res.status).toBe(403);
  });
});

describe('Purchase desk — PO → Billed → Dispatch', () => {
  it('moves a released PO through the seller’s invoice and the hand-over, without blocking dispatch', async () => {
    const { soId, sales, purchase } = await raiseSo();
    const poId = await payOrder(sales.token, soId);

    const inPo = async () =>
      (
        (await get(purchase.token, '/staff/purchase/pos')).body.data as Array<{ poId: string }>
      ).some((r) => r.poId === poId);
    const inBilled = async () =>
      (
        (await get(purchase.token, '/staff/purchase/billed')).body.data as Array<{ poId: string }>
      ).some((r) => r.poId === poId);
    const inDispatch = async () =>
      (
        (await get(purchase.token, '/staff/purchase/dispatch')).body.data as Array<{
          poId: string;
          invoiceRecorded: boolean;
        }>
      ).find((r) => r.poId === poId);

    // Just released: on the PO screen only; not Billed, and not yet in Dispatch (its clock is fresh).
    expect(await inPo()).toBe(true);
    expect(await inBilled()).toBe(false);
    expect(await inDispatch()).toBeUndefined();

    // Handing over before the invoice is refused.
    const tooSoon = await request(app)
      .post(`/api/v1/staff/purchase/pos/${poId}/hand-to-dispatch`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'Send it.' });
    expect(tooSoon.status).toBe(409);

    const invoice = {
      invoiceNo: `SINV-${Date.now()}`,
      date: new Date().toISOString(),
      ewayNo: 'EWAY123456',
      callNote: 'He read the invoice and e-way bill out.',
    };
    const billed = await request(app)
      .post(`/api/v1/staff/purchase/pos/${poId}/invoice`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(invoice);
    expect(billed.status).toBe(201);
    expect(await inPo()).toBe(false);
    expect(await inBilled()).toBe(true);

    // The invoice can't be recorded twice.
    const twice = await request(app)
      .post(`/api/v1/staff/purchase/pos/${poId}/invoice`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(invoice);
    expect(twice.status).toBe(409);

    const handed = await request(app)
      .post(`/api/v1/staff/purchase/pos/${poId}/hand-to-dispatch`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ callNote: 'Ready for him to send.' });
    expect(handed.status).toBe(200);
    expect(await inBilled()).toBe(false);
    expect((await inDispatch())?.invoiceRecorded).toBe(true);

    const po = (await Po.findById(poId))!;
    expect(po.proxyLog.map((p) => p.action)).toEqual(
      expect.arrayContaining(['record_seller_invoice', 'hand_to_dispatch']),
    );
    expect((await So.findById(soId))!.state).toBe('po_released');
  });

  it('never hides a PO the dispatch clock has marked missed, and leg 1 is not blocked by a missing invoice', async () => {
    const { soId, sales, purchase } = await raiseSo();
    const poId = await payOrder(sales.token, soId);
    // The clock job has marked the same-day dispatch missed.
    await Po.updateOne({ _id: poId }, { $set: { sameDayMissAt: new Date() } });
    const row = (
      (await get(purchase.token, '/staff/purchase/dispatch')).body.data as Array<{
        poId: string;
        bucket: string;
        invoiceRecorded: boolean;
      }>
    ).find((r) => r.poId === poId);
    expect(row).toMatchObject({ bucket: 'overdue', invoiceRecorded: false });

    const logistics = await staffToken(app, 'transport_logistics');
    const chainId = String((await Po.findById(poId))!.chainId);
    const leg1 = await request(app)
      .post(`/api/v1/staff/chains/${chainId}/movements`)
      .set('Authorization', `Bearer ${logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'MP09AB1234',
        driver: 'Ramu',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(leg1.status).toBe(201);
    const moved = (
      (await get(purchase.token, '/staff/purchase/dispatch')).body.data as Array<{
        poId: string;
        bucket: string;
        invoiceRecorded: boolean;
      }>
    ).find((r) => r.poId === poId);
    expect(moved).toMatchObject({ bucket: 'in_transit', invoiceRecorded: false });
  });
});
