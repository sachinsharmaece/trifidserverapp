import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Po } from '../src/models/Po.js';
import { Buyer } from '../src/models/Buyer.js';
import { Counterparty } from '../src/models/Counterparty.js';
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

interface Stage {
  key: string;
  count: number | null;
  leakCount?: number;
  reached: boolean;
}

describe('Purchase desk — the seller file funnel', () => {
  it('places each of one seller’s orders at its own stage, agrees with the desk tabs, and carries no money or buyer', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const logistics = await staffToken(app, 'transport_logistics');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const skuId = await createTestSku('Medium');
    await seedMarginCell('Medium', 'Dealer', 0.05, admin.employeeId);

    const raise = async (): Promise<string> => {
      const res = await request(app)
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
      expect(res.status).toBe(201);
      return (res.body.data as { soId: string }).soId;
    };
    const pay = async (soId: string): Promise<string> => {
      const res = await request(app)
        .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
        .set('Authorization', `Bearer ${sales.token}`)
        .set('Idempotency-Key', idemKey())
        .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
      expect(res.status).toBe(201);
      return (res.body.data as { poId: string }).poId;
    };
    const post = (path: string, body: object) =>
      request(app)
        .post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${purchase.token}`)
        .send(body);
    const invoice = (poId: string) =>
      post(`/staff/purchase/pos/${poId}/invoice`, {
        invoiceNo: `SINV-${Date.now()}-${Math.random()}`,
        date: new Date().toISOString(),
        ewayNo: 'EWAY1',
        callNote: 'Billed.',
      });
    const get = (path: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${purchase.token}`);

    // Stock: confirmed, unpaid, no hold asked yet.
    await raise();
    // PO: paid, no seller invoice.
    await pay(await raise());
    // Billed: paid and invoiced.
    const billedPo = await pay(await raise());
    expect((await invoice(billedPo)).status).toBe(201);
    // Dispatch (handed over).
    const handedPo = await pay(await raise());
    await invoice(handedPo);
    expect(
      (await post(`/staff/purchase/pos/${handedPo}/hand-to-dispatch`, { callNote: 'Go.' })).status,
    ).toBe(200);
    // Dispatch (on the way), later received.
    const transitPo = await pay(await raise());
    const chainId = String((await Po.findById(transitPo))!.chainId);
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
    // Paid out: finished with the seller.
    const paidPo = await pay(await raise());
    await Po.updateOne({ _id: paidPo }, { $set: { state: 'dispatched_leg2', paid: true } });

    let res = await get(`/staff/purchase/sellers/${sellerId}/funnel`);
    expect(res.status).toBe(200);
    let funnel = res.body.data.funnel as Stage[];
    const count = (key: string) => funnel.find((s) => s.key === key)!;
    expect(funnel.map((s) => s.key)).toEqual([
      'approved',
      'carries',
      'on_board',
      'quoted',
      'confirmations',
      'stock',
      'po',
      'billed',
      'dispatch',
      'received',
      'paid',
    ]);
    expect(count('approved')).toMatchObject({ count: null, reached: true });
    expect(count('stock')).toMatchObject({ count: 1, leakCount: 1 }); // No hold asked yet.
    expect(count('po').count).toBe(1);
    expect(count('billed').count).toBe(1);
    expect(count('dispatch').count).toBe(2); // Handed over + on the way.
    expect(count('received').count).toBe(0);
    expect(count('paid').count).toBe(1);

    // The same numbers as the desk's own tabs, for this seller.
    for (const [tab, key] of [
      ['stock', 'stock'],
      ['pos', 'po'],
      ['billed', 'billed'],
      ['dispatch', 'dispatch'],
    ] as const) {
      const rows = (await get(`/staff/purchase/${tab}`)).body.data as Array<{ sellerId: string }>;
      expect(rows.filter((r) => r.sellerId === sellerId).length).toBe(count(key).count);
    }

    // Asking for the hold clears that leak; the goods then arrive at Indore.
    const stockRow = (res.body.data.stages.stock as Array<{ soId: string }>)[0]!;
    await post(`/staff/purchase/stock/${stockRow.soId}/hold`, { callNote: 'Asked him.' });
    await Po.updateOne(
      { _id: transitPo },
      { $set: { state: 'at_indore', receivedAt: new Date() } },
    );
    res = await get(`/staff/purchase/sellers/${sellerId}/funnel`);
    funnel = res.body.data.funnel as Stage[];
    expect(count('stock')).toMatchObject({ count: 1, leakCount: 0 });
    expect(count('dispatch').count).toBe(1);
    expect(count('received').count).toBe(1);

    // The wall: counts and goods only — no rupee key, no buyer.
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/paise|rupee|"rate"|total/i);
    const buyer = (await Buyer.findById(buyerId))!;
    const counterparty = (await Counterparty.findById(buyer.counterpartyId))!;
    expect(text).not.toContain(String(counterparty._id));
    expect(text).not.toContain(counterparty.firm ?? '\u0000');
  });

  it('404s for an unknown seller and is closed to a role without po:edit', async () => {
    const purchase = await staffToken(app, 'purchase');
    const missing = await request(app)
      .get('/api/v1/staff/purchase/sellers/000000000000000000000000/funnel')
      .set('Authorization', `Bearer ${purchase.token}`);
    expect(missing.status).toBe(404);
    const sales = await staffToken(app, 'sales');
    const denied = await request(app)
      .get('/api/v1/staff/purchase/sellers/000000000000000000000000/funnel')
      .set('Authorization', `Bearer ${sales.token}`);
    expect(denied.status).toBe(403);
  });
});
