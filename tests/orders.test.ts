import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { signAccessToken } from '../src/shared/tokens.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

function idemKey(): string {
  return `orders-${Date.now()}-${Math.random()}`;
}

async function tokenForCounterparty(counterpartyId: string): Promise<string> {
  return signAccessToken({
    sub: counterpartyId,
    actorType: 'counterparty',
    counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

async function seedPaidSo() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');

  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('B');
  await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);

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
  const so = await So.findById(soId);

  const { createUpcomingReceipt, allocateUpcomingReceipt, postBankCredit } =
    await import('../src/modules/payment/payment.service.js');
  const { upcomingReceiptId } = await createUpcomingReceipt(buyerId, {
    amountPaise: so!.totalPaise,
    method: 'utr',
    utr: `UTR-${Date.now()}-${Math.random()}`,
  });
  await allocateUpcomingReceipt(upcomingReceiptId, [soId], {
    employeeId: sales.employeeId,
    correlationId: 'test',
  });
  await postBankCredit(
    upcomingReceiptId,
    {
      utr: `STMT-${Date.now()}-${Math.random()}`,
      remitterAccountNumber: '1',
      remitterIfsc: 'HDFC0001234',
    },
    { employeeId: accounts.employeeId, correlationId: 'test' },
  );

  const poRes = await request(app)
    .post(`/api/v1/staff/so/${soId}/po`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', idemKey())
    .send({});
  expect(poRes.status).toBe(201);
  const { poId } = poRes.body.data as { poId: string };

  const buyer = await Buyer.findById(buyerId);
  const seller = await Seller.findById(sellerId);
  const buyerToken = await tokenForCounterparty(
    (buyer!.counterpartyId as unknown as string).toString(),
  );
  const sellerToken = await tokenForCounterparty(
    (seller!.counterpartyId as unknown as string).toString(),
  );

  return { soId, poId, buyerId, sellerId, buyerToken, sellerToken, sales, purchase, accounts };
}

describe('API-070 — orders list/detail, the wall in both directions', () => {
  it('BR-060 — the buyer order response carries no sellerId, no seller net', async () => {
    const { soId, buyerToken } = await seedPaidSo();
    const res = await request(app)
      .get(`/api/v1/orders/${soId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rung).toBe('seller_confirmed');
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain('sellerid');
    expect(raw).not.toContain('sellernet');
  });

  it('BR-138 — the seller order response carries no buyerId and no delivery location', async () => {
    const { poId, sellerToken } = await seedPaidSo();
    const res = await request(app)
      .get(`/api/v1/seller/orders/${poId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain('buyerid');
    expect(raw).not.toContain('deliverylocation');
    expect(res.body.data.canDispatchLeg1).toBe(true);
  });
});

describe('API-075 — the seller self-dispatches leg 1', () => {
  it('moves the SO/PO to dispatched_leg1 and shows up on the buyer order too', async () => {
    const { soId, poId, sellerToken, buyerToken } = await seedPaidSo();
    const res = await request(app)
      .post(`/api/v1/seller/orders/${poId}/dispatch`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        mode: 'bus',
        busNo: 'MP09XX1234',
        driver: 'Ramu',
        driverMobile: '9000000000',
        photoRef: 'photo-1',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(res.status).toBe(201);

    const so = await So.findById(soId);
    expect(so!.state).toBe('dispatched_leg1');
    const po = await Po.findById(poId);
    expect(po!.state).toBe('dispatched_leg1');

    const buyerView = await request(app)
      .get(`/api/v1/orders/${soId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(buyerView.body.data.rung).toBe('leg1_dispatch');
    expect(buyerView.body.data.leg1.mode).toBe('bus');
  });

  it('BR-176 — transport mode without an LR number is refused', async () => {
    const { poId, sellerToken } = await seedPaidSo();
    const res = await request(app)
      .post(`/api/v1/seller/orders/${poId}/dispatch`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        mode: 'transport',
        transporter: 'Acme Transport',
        freightTerms: 'prepaid',
        freightAmountPaise: 100,
      });
    expect(res.status).toBe(400);
  });

  it('cannot dispatch twice', async () => {
    const { poId, sellerToken } = await seedPaidSo();
    const first = await request(app)
      .post(`/api/v1/seller/orders/${poId}/dispatch`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        mode: 'bus',
        busNo: 'MP09XX1234',
        driver: 'Ramu',
        driverMobile: '9000000000',
        photoRef: 'photo-1',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/seller/orders/${poId}/dispatch`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        mode: 'bus',
        busNo: 'MP09XX1234',
        driver: 'Ramu',
        driverMobile: '9000000000',
        photoRef: 'photo-1',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ORDER_NOT_DISPATCHABLE');
  });
});

describe('API-073/API-074 — confirm receipt and complaints, BR-192/BR-201', () => {
  it('confirmReceipt refuses before leg 2 has dispatched', async () => {
    const { soId, buyerToken } = await seedPaidSo();
    const res = await request(app)
      .post(`/api/v1/orders/${soId}/confirm-receipt`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_YET_DELIVERABLE');
  });

  it('closes the order once leg 2 has dispatched, and a complaint instead marks it disputed', async () => {
    const fixture = await seedPaidSo();
    await So.updateOne({ _id: fixture.soId }, { $set: { state: 'dispatched_leg2' } });

    const confirmRes = await request(app)
      .post(`/api/v1/orders/${fixture.soId}/confirm-receipt`)
      .set('Authorization', `Bearer ${fixture.buyerToken}`);
    expect(confirmRes.status).toBe(200);
    expect((await So.findById(fixture.soId))!.state).toBe('closed');
  });

  it('a complaint stops the order at disputed and is listed back to the buyer', async () => {
    const fixture = await seedPaidSo();
    await So.updateOne({ _id: fixture.soId }, { $set: { state: 'dispatched_leg2' } });

    const complaintRes = await request(app)
      .post(`/api/v1/orders/${fixture.soId}/complaints`)
      .set('Authorization', `Bearer ${fixture.buyerToken}`)
      .send({ category: 'transit_damage', note: 'Carton was crushed.' });
    expect(complaintRes.status).toBe(201);
    expect((await So.findById(fixture.soId))!.state).toBe('disputed');

    const listRes = await request(app)
      .get(`/api/v1/orders/${fixture.soId}/complaints`)
      .set('Authorization', `Bearer ${fixture.buyerToken}`);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].category).toBe('transit_damage');
  });
});

describe('API-110/API-111 — conduct and scorecard', () => {
  it('scorecard reflects real Po aggregates, not a fabricated grade', async () => {
    const { sellerToken } = await seedPaidSo();
    const res = await request(app)
      .get('/api/v1/me/scorecard')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.poCount).toBe(1);
    expect(res.body.data.trustTier).toBe('New');
  });

  it('conduct is honest about there being no strike system yet', async () => {
    const { buyerToken } = await seedPaidSo();
    const res = await request(app)
      .get('/api/v1/me/conduct')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.strikeCount).toBe(0);
    expect(res.body.data.rateViewThreshold).toBe(25);
  });
});
