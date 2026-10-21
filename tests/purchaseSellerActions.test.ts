import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Po } from '../src/models/Po.js';
import { So } from '../src/models/So.js';
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

interface AfterRow {
  poId: string;
  inspection: 'none' | 'recorded' | 'applied';
  state: string;
}

describe('Purchase desk — moving a PO forward from the seller file', () => {
  it('records leg 1 as the seller’s dispatch, then reads inspection none → recorded → applied', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const logistics = await staffToken(app, 'transport_logistics');
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
    const { soId } = soRes.body.data as { soId: string };
    const paid = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
    const { poId } = paid.body.data as { poId: string };

    const funnel = async () =>
      (
        await request(app)
          .get(`/api/v1/staff/purchase/sellers/${sellerId}/funnel`)
          .set('Authorization', `Bearer ${purchase.token}`)
      ).body.data as {
        funnel: Array<{ key: string; count: number | null }>;
        stages: { dispatch: Array<{ poId: string; bucket: string }>; received: AfterRow[] };
      };
    const dispatched = (body: object, key = idemKey()) =>
      request(app)
        .post(`/api/v1/staff/purchase/pos/${poId}/seller-dispatched`)
        .set('Authorization', `Bearer ${purchase.token}`)
        .set('Idempotency-Key', key)
        .send(body);

    // The same BR-176 rules as Logistics: transport mode needs an LR.
    const noLr = await dispatched({
      mode: 'transport',
      freightTerms: 'prepaid',
      callNote: 'He sent it.',
    });
    expect(noLr.status).toBeGreaterThanOrEqual(400);
    expect(noLr.status).toBeLessThan(500);
    expect((await Po.findById(poId))!.state).toBe('released');

    // Closed to a role that cannot act for a seller.
    const denied = await request(app)
      .post(`/api/v1/staff/purchase/pos/${poId}/seller-dispatched`)
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ mode: 'transport', lr: 'LR1', freightTerms: 'prepaid', callNote: 'Not Sales.' });
    expect(denied.status).toBe(403);

    const sent = await dispatched({
      mode: 'transport',
      transporter: 'VRL',
      lr: 'LR-12345',
      freightTerms: 'to_pay',
      callNote: 'He sent it with VRL this afternoon.',
    });
    expect(sent.status).toBe(201);
    const po = (await Po.findById(poId))!;
    expect(po.state).toBe('dispatched_leg1');
    expect(po.proxyLog.map((p) => p.action)).toContain('seller_dispatched');
    expect((await So.findById(soId))!.state).toBe('dispatched_leg1');

    // It cannot be recorded twice: the PO has left the released stage.
    expect(
      (
        await dispatched({
          mode: 'bus',
          busNo: 'B1',
          driver: 'D',
          driverMobile: '9',
          freightTerms: 'prepaid',
          callNote: 'Again.',
        })
      ).status,
    ).toBe(409);

    let data = await funnel();
    expect(data.stages.dispatch.find((d) => d.poId === poId)?.bucket).toBe('in_transit');
    expect(data.funnel.find((s) => s.key === 'received')!.count).toBe(0);

    // The dock's own steps: goods-in, then the finding.
    const goodsIn = await request(app)
      .post(`/api/v1/staff/logistics/pos/${poId}/goods-in`)
      .set('Authorization', `Bearer ${logistics.token}`)
      .send({});
    expect(goodsIn.status).toBeLessThan(300);
    data = await funnel();
    expect(data.stages.received.find((r) => r.poId === poId)?.inspection).toBe('none');

    const inspect = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: 10, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
    expect(inspect.status).toBe(201);
    data = await funnel();
    expect(data.stages.received.find((r) => r.poId === poId)?.inspection).toBe('recorded');

    // Purchase's own step — applying the finding.
    const applied = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(applied.status).toBe(200);
    data = await funnel();
    expect(data.stages.received.find((r) => r.poId === poId)).toMatchObject({
      inspection: 'applied',
      state: 'inspected',
    });
  });
});
