import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Bankbook } from '../src/models/Bankbook.js';
import { Ask } from '../src/models/Ask.js';
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

async function raiseSo(): Promise<{ soId: string; salesToken: string; buyerId: string }> {
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
  return { soId: (soRes.body.data as { soId: string }).soId, salesToken: sales.token, buyerId };
}

describe('Buyer file stage buttons — Payment pending → Paid', () => {
  it('Sales marks an order paid: receipt posted against the UTR, PO released, SO in the Paid group', async () => {
    const { soId, salesToken } = await raiseSo();
    const utr = `UTR${Date.now()}${Math.floor(Math.random() * 1000)}`;

    const res = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr, callNote: 'He read the UTR out on the phone.' });
    expect(res.status).toBe(201);

    const so = await So.findById(soId);
    expect(so!.state).toBe('po_released');
    const entry = await Bankbook.findOne({ utr });
    expect(entry!.amountPaise).toBe(so!.totalPaise);
    expect(entry!.remitterAccountEncrypted).toBeNull();
    expect(await Po.exists({ soId })).toBeTruthy();
    expect(so!.proxyLog.at(-1)!.action).toBe('mark_paid');
  });

  it('refuses a UTR already on the bank book, and an order that is no longer unpaid', async () => {
    const first = await raiseSo();
    const utr = `UTR${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await request(app)
      .post(`/api/v1/staff/sales/orders/${first.soId}/mark-paid`)
      .set('Authorization', `Bearer ${first.salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr, callNote: 'Paid.' });

    const again = await request(app)
      .post(`/api/v1/staff/sales/orders/${first.soId}/mark-paid`)
      .set('Authorization', `Bearer ${first.salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr, callNote: 'Paid again?' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);

    const second = await raiseSo();
    const reused = await request(app)
      .post(`/api/v1/staff/sales/orders/${second.soId}/mark-paid`)
      .set('Authorization', `Bearer ${second.salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr, callNote: 'Same UTR as another order.' });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(reused.status).toBeLessThan(500);
    expect((await So.findById(second.soId))!.state).toBe('awaiting_payment');
  });

  it('is closed to a role without sales:mark_paid', async () => {
    const { soId } = await raiseSo();
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr: `UTR${Date.now()}`, callNote: 'Not mine to take.' });
    expect(res.status).toBe(403);
  });
});

describe('Buyer file stage buttons — cancel an unpaid order', () => {
  it('cancels an unpaid order with the call note kept on it, and refuses once it is paid', async () => {
    const { soId, salesToken } = await raiseSo();
    const res = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ callNote: 'He changed his mind.' });
    expect(res.status).toBe(200);
    const so = await So.findById(soId);
    expect(so!.state).toBe('cancelled');
    expect(so!.proxyLog.at(-1)!.callNote).toBe('He changed his mind.');

    const paid = await raiseSo();
    await request(app)
      .post(`/api/v1/staff/sales/orders/${paid.soId}/mark-paid`)
      .set('Authorization', `Bearer ${paid.salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 1000)}`, callNote: 'Paid.' });
    const refused = await request(app)
      .post(`/api/v1/staff/sales/orders/${paid.soId}/cancel`)
      .set('Authorization', `Bearer ${paid.salesToken}`)
      .send({ callNote: 'Too late.' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await So.findById(paid.soId))!.state).toBe('po_released');
  });
});

/** Pays the order and takes it through leg 1 and a clean dock inspection, to `inspected`. */
async function takeToInspected(salesToken: string, soId: string): Promise<{ chainId: string }> {
  const purchase = await staffToken(app, 'purchase');
  const logistics = await staffToken(app, 'transport_logistics');
  const paid = await request(app)
    .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
    .set('Authorization', `Bearer ${salesToken}`)
    .set('Idempotency-Key', idemKey())
    .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
  expect(paid.status).toBe(201);
  const { poId } = paid.body.data as { poId: string };
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
  const inspect = await request(app)
    .post(`/api/v1/staff/pos/${poId}/inspections`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ casesAccepted: 10, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
  expect(inspect.status).toBe(201);
  const apply = await request(app)
    .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', idemKey())
    .send({});
  expect(apply.status).toBe(200);
  return { chainId };
}

describe('Buyer file stage buttons — Paid → Billed → Dispatch → Delivered', () => {
  const dispatchBody = {
    mode: 'bus',
    busNo: 'MP09CD5678',
    driver: 'Shyam',
    driverMobile: '9000000001',
    freightTerms: 'to_pay',
    freightAmountPaise: 0,
    callNote: 'Bus leaves Indore tonight.',
  };

  it('walks an inspected order through billed, dispatched and delivered, keeping each guard', async () => {
    const { soId, salesToken } = await raiseSo();
    await takeToInspected(salesToken, soId);
    const so = (await So.findById(soId))!;
    expect(so.state).toBe('inspected');

    // Dispatch before billing is refused.
    const early = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/dispatch`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send(dispatchBody);
    expect(early.status).toBe(409);

    // A Marg value more than ₹5 off is a query: nothing advances.
    const query = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-billed`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: `INV-${Date.now()}`,
        date: new Date().toISOString(),
        valuePaise: so.totalPaise + 100000,
        ewayNo: 'EW123456',
        callNote: 'Keyed the bill.',
      });
    expect(query.status).toBe(201);
    expect(query.body.data.state).toBe('query');
    expect((await So.findById(soId))!.state).toBe('inspected');

    const billed = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-billed`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: `INV-${Date.now()}`,
        date: new Date().toISOString(),
        valuePaise: so.totalPaise,
        ewayNo: 'EW123456',
        callNote: 'Keyed the bill.',
      });
    expect(billed.status).toBe(201);
    expect(billed.body.data.state).toBe('matched');
    expect((await So.findById(soId))!.state).toBe('billed_in_marg');

    // Delivered before dispatch is refused.
    const tooSoon = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-delivered`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ callNote: 'He has it.' });
    expect(tooSoon.status).toBe(409);

    const dispatched = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/dispatch`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send(dispatchBody);
    expect(dispatched.status).toBe(201);
    expect((await So.findById(soId))!.state).toBe('dispatched_leg2');

    const delivered = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-delivered`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ callNote: 'He called to say it arrived.' });
    expect(delivered.status).toBe(200);
    const closed = (await So.findById(soId))!;
    expect(closed.state).toBe('closed');
    expect(closed.proxyLog.map((p) => p.action)).toEqual(
      expect.arrayContaining(['mark_paid', 'mark_billed', 'dispatch', 'mark_delivered']),
    );
  });

  it('skip-to-billed takes a po_released order to Billed, leaving real records, and refuses a wrong value without changing anything', async () => {
    const { soId, salesToken } = await raiseSo();
    await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
    const so = (await So.findById(soId))!;
    expect(so.state).toBe('po_released');
    const body = {
      margInvoiceNo: `INV-${Date.now()}`,
      date: new Date().toISOString(),
      ewayNo: 'EW123456',
      callNote: 'Skipping ahead for now.',
    };

    const wrong = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/skip-to-billed`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ ...body, valuePaise: so.totalPaise + 100000 });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await So.findById(soId))!.state).toBe('po_released');

    const res = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/skip-to-billed`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ ...body, valuePaise: so.totalPaise });
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('matched');
    expect((await So.findById(soId))!.state).toBe('billed_in_marg');
    const po = (await Po.findOne({ soId }))!;
    const { Inspection } = await import('../src/models/Inspection.js');
    const { Movement } = await import('../src/models/Movement.js');
    expect(await Inspection.exists({ poId: po._id })).toBeTruthy();
    expect(await Movement.exists({ chainId: po.chainId, leg: 1 })).toBeTruthy();

    // The skipped order can now be dispatched like any other billed order.
    const dispatched = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/dispatch`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        mode: 'bus',
        busNo: 'MP09CD5678',
        driver: 'Shyam',
        driverMobile: '9000000001',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
        callNote: 'Leaving tonight.',
      });
    expect(dispatched.status).toBe(201);
  });

  it('refuses Mark billed on an order the dock has not inspected', async () => {
    const { soId, salesToken } = await raiseSo();
    await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
    const so = (await So.findById(soId))!;
    const res = await request(app)
      .post(`/api/v1/staff/sales/orders/${soId}/mark-billed`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: `INV-${Date.now()}`,
        date: new Date().toISOString(),
        valuePaise: so.totalPaise,
        ewayNo: 'EW123456',
        callNote: 'Keyed the bill.',
      });
    expect(res.status).toBe(409);
    expect((await So.findById(soId))!.state).toBe('po_released');
  });
});

describe('Buyer file stage buttons — give a rate', () => {
  it('refuses a rate that is not on the buyer’s board and leaves the ask open', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const skuId = await createTestSku('Medium');
    const { Buyer } = await import('../src/models/Buyer.js');
    const counterpartyId = (await Buyer.findById(buyerId))!.counterpartyId!.toString();

    const askRes = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId: counterpartyId,
        skuId,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'He wants five boxes.',
      });
    expect(askRes.status).toBe(201);
    const { askId } = askRes.body.data as { askId: string };

    const res = await request(app)
      .post(`/api/v1/staff/sales/asks/${askId}/give-rate`)
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ listingLineId: '64b000000000000000000000', callNote: 'Quoting him a rate.' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await Ask.findById(askId))!.state).toBe('open');
  });
});
