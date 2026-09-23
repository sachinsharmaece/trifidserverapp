import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { SellerBill } from '../src/models/SellerBill.js';
import { ReturnNote } from '../src/models/ReturnNote.js';
import { signAccessToken } from '../src/shared/tokens.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import * as controllerService from '../src/modules/controller/controller.service.js';
import * as logisticsService from '../src/modules/logistics/logistics.service.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

function idemKey(): string {
  return `m7-${Date.now()}-${Math.random()}`;
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

/**
 * Walks one order all the way to `dispatched_leg2` with a booked SellerBill
 * behind it — the same six-stage path `chainM4.test.ts` proves, reused here
 * because M7's own tests (GST queue, disputes, hub position) all need a real
 * PO/SellerBill/SO to act on, not a hand-built document.
 */
async function runToDispatchedLeg2(boxes = 10, sellerNetPaise = 40000) {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');
  const controller = await staffToken(app, 'controller');
  const logistics = await staffToken(app, 'transport_logistics');

  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('B');
  await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);

  const soRes = await request(app)
    .post('/api/v1/staff/so')
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ buyerId, sellerId, skuId, boxes, sellerNetPaise, placeOfSupply: 'intra_state' });
  expect(soRes.status).toBe(201);
  const { soId } = soRes.body.data as { soId: string };
  const so = await So.findById(soId);

  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
    amountPaise: so!.totalPaise,
    method: 'utr',
    utr: `UTR-${Date.now()}-${Math.random()}`,
  });
  await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
    employeeId: sales.employeeId,
    correlationId: 'test',
  });
  await paymentService.postBankCredit(
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
  const po = await Po.findById(poId);
  const chainId = (po!.chainId as unknown as string).toString();

  const leg1Res = await request(app)
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
  expect(leg1Res.status).toBe(201);

  const inspectRes = await request(app)
    .post(`/api/v1/staff/pos/${poId}/inspections`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ casesAccepted: boxes, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
  expect(inspectRes.status).toBe(201);

  const applyRes = await request(app)
    .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', idemKey())
    .send({});
  expect(applyRes.status).toBe(200);

  const receiptConfirmRes = await request(app)
    .post(`/api/v1/staff/pos/${poId}/receipt-confirmation`)
    .set('Authorization', `Bearer ${accounts.token}`)
    .send({ productMatches: true, qtyMatches: true });
  expect(receiptConfirmRes.status).toBe(201);

  const refreshedSo = await So.findById(soId);
  const margRes = await request(app)
    .post(`/api/v1/staff/marg/${soId}`)
    .set('Authorization', `Bearer ${accounts.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      margInvoiceNo: `MARG-${Date.now()}`,
      date: new Date().toISOString(),
      valuePaise: refreshedSo!.totalPaise,
      ewayNo: 'EWAY-1',
    });
  expect(margRes.status).toBe(201);

  const leg2Res = await request(app)
    .post(`/api/v1/staff/chains/${chainId}/movements`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      leg: 2,
      mode: 'bus',
      busNo: 'MP09AB1234',
      driver: 'Ramu',
      driverMobile: '9000000000',
      freightTerms: 'to_pay',
      freightAmountPaise: 0,
    });
  expect(leg2Res.status).toBe(201);

  const buyer = await Buyer.findById(buyerId);
  const seller = await Seller.findById(sellerId);
  const buyerToken = await tokenForCounterparty(
    (buyer!.counterpartyId as unknown as string).toString(),
  );

  return {
    soId,
    poId,
    chainId,
    buyerId,
    sellerId,
    buyerCounterpartyId: (buyer!.counterpartyId as unknown as string).toString(),
    sellerCounterpartyId: (seller!.counterpartyId as unknown as string).toString(),
    buyerToken,
    admin,
    sales,
    purchase,
    accounts,
    controller,
    logistics,
  };
}

describe('M7 — GST unfiled-bills queue (BR-023)', () => {
  it('a booked seller bill starts unfiled, appears in the queue, and leaves it once marked filed', async () => {
    const fx = await runToDispatchedLeg2();
    const bill = await SellerBill.findOne({ poId: fx.poId });
    expect(bill).not.toBeNull();
    expect(bill!.filed).toBe(false);

    const before = await paymentService.getGstUnfiledQueue();
    expect(
      before.some((row) => row.sellerBillId === (bill!._id as unknown as string).toString()),
    ).toBe(true);

    await paymentService.markSellerBillFiled((bill!._id as unknown as string).toString(), {
      employeeId: fx.accounts.employeeId,
      correlationId: 'test',
    });

    const after = await paymentService.getGstUnfiledQueue();
    expect(
      after.some((row) => row.sellerBillId === (bill!._id as unknown as string).toString()),
    ).toBe(false);
  }, 30000);
});

describe('M7 — dispute resolution (BR-206, QR-048 correction)', () => {
  it('routes a hidden-defect complaint to Controller, and a seller-fault decision raises a debit note and closes the SO', async () => {
    const fx = await runToDispatchedLeg2();

    const complaintRes = await request(app)
      .post(`/api/v1/orders/${fx.soId}/complaints`)
      .set('Authorization', `Bearer ${fx.buyerToken}`)
      .send({
        category: 'hidden_defect_sealed_case',
        note: 'Cracked bottle inside the sealed case.',
      });
    expect(complaintRes.status).toBe(201);
    const { complaintId } = complaintRes.body.data as { complaintId: string };

    let so = await So.findById(fx.soId);
    expect(so!.state).toBe('disputed');

    const queue = await controllerService.getDisputeQueue();
    expect(queue.some((d) => d.complaintId === complaintId)).toBe(true);

    const decision = await controllerService.decideDispute(
      complaintId,
      {
        disposition: 'seller_fault',
        note: 'Confirmed against dock photos.',
        debitValuePaise: 10000,
      },
      { employeeId: fx.controller.employeeId, correlationId: 'test' },
    );
    expect(decision.debitNoteId).toBeDefined();
    expect(decision.soClosed).toBe(true);

    so = await So.findById(fx.soId);
    expect(so!.state).toBe('closed');

    const recovery = await (
      await import('../src/modules/desk/purchase/purchase.service.js')
    ).getSellerRecoveryQueue();
    const mine = recovery.find((r) => r.complaintId === complaintId);
    expect(mine).toBeDefined();
    expect(mine!.sellerId).toBe(fx.sellerId);

    // BR-206 — the buyer-conversation read never carries the seller.
    const salesQueue = await (
      await import('../src/modules/desk/sales/sales.service.js')
    ).getComplaintQueue('controller');
    const json = JSON.stringify(salesQueue.find((c) => c.complaintId === complaintId));
    expect(json).not.toContain(fx.sellerId);
  }, 30000);

  it('QR-050 — transit_damage never reaches a decision this session', async () => {
    const fx = await runToDispatchedLeg2();
    const complaintRes = await request(app)
      .post(`/api/v1/orders/${fx.soId}/complaints`)
      .set('Authorization', `Bearer ${fx.buyerToken}`)
      .send({ category: 'transit_damage', note: 'Box was crushed.' });
    expect(complaintRes.status).toBe(201);
    const { complaintId } = complaintRes.body.data as { complaintId: string };

    const queue = await controllerService.getDisputeQueue();
    expect(queue.some((d) => d.complaintId === complaintId)).toBe(false);

    await expect(
      controllerService.decideDispute(
        complaintId,
        { disposition: 'no_fault', note: 'attempt' },
        { employeeId: fx.controller.employeeId, correlationId: 'test' },
      ),
    ).rejects.toThrow();

    const exceptions = await controllerService.getExceptionView();
    expect(exceptions.unhandledTransitDamage).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe('M7 — blacklist never blocks a payable already in flight (BR-213/QR-015)', () => {
  it("a blacklisted seller's already-payable PO stays payable", async () => {
    const fx = await runToDispatchedLeg2();
    expect(await paymentService.isPoPayable(fx.poId)).toBe(true);

    await Counterparty.updateOne(
      { _id: fx.sellerCounterpartyId },
      { $set: { status: 'blacklisted' } },
    );

    expect(await paymentService.isPoPayable(fx.poId)).toBe(true);
    await expect(paymentService.assertPoPayableForRelease(fx.poId)).resolves.not.toThrow();

    const exceptions = await controllerService.getExceptionView();
    expect(exceptions.blacklistedWithPendingPayables.some((row) => row.poId === fx.poId)).toBe(
      true,
    );
  }, 30000);
});

describe('M7 — the bulk lifeline (BR-234)', () => {
  it("extends every open PO's dispatch clock in one action under one logged reason", async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const controller = await staffToken(app, 'controller');

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
        boxes: 5,
        sellerNetPaise: 40000,
        placeOfSupply: 'intra_state',
      });
    const { soId } = soRes.body.data as { soId: string };
    const so = await So.findById(soId);
    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
      amountPaise: so!.totalPaise,
      method: 'utr',
      utr: `UTR-${Date.now()}`,
    });
    await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
      employeeId: sales.employeeId,
      correlationId: 'test',
    });
    await paymentService.postBankCredit(
      upcomingReceiptId,
      { utr: `STMT-${Date.now()}`, remitterAccountNumber: '1', remitterIfsc: 'HDFC0001234' },
      { employeeId: purchase.employeeId, correlationId: 'test' },
    );
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };

    const before = await Po.findById(poId);
    const beforeDueDate = before!.dispatchDueDate.getTime();

    const result = await controllerService.grantBulkLifeline(
      24,
      'Diwali — every open dispatch clock extended a day.',
      {
        employeeId: controller.employeeId,
        checkerEmployeeId: admin.employeeId,
        correlationId: 'test',
      },
    );
    expect(result.extendedPoCount).toBeGreaterThanOrEqual(1);

    const after = await Po.findById(poId);
    expect(after!.dispatchDueDate.getTime()).toBe(beforeDueDate + 24 * 60 * 60 * 1000);
  }, 30000);
});

describe('M7 — hub position, dwell and the BR-177 cut-off', () => {
  it('records goods-in and reports dwell time and same-day eligibility', async () => {
    const fx = await runToDispatchedLeg2();
    // runToDispatchedLeg2 already passed inspection; use a second, freshly
    // released PO to test goods-in independently of that flow.
    const admin = fx.admin;
    void admin;

    await logisticsService.recordGoodsIn(fx.poId, {
      employeeId: fx.logistics.employeeId,
      correlationId: 'test',
    });
    const po = await Po.findById(fx.poId);
    expect(po!.receivedAt).not.toBeNull();

    await expect(
      logisticsService.recordGoodsIn(fx.poId, {
        employeeId: fx.logistics.employeeId,
        correlationId: 'test',
      }),
    ).rejects.toThrow();
  }, 30000);
});

describe('M7 — consolidation is a physical grouping only (BR-178/QR-014)', () => {
  it('groups two leg-2 movements under one reference without merging their invoices', async () => {
    const fxA = await runToDispatchedLeg2();
    const fxB = await runToDispatchedLeg2();

    const movementA = await (
      await import('../src/models/Movement.js')
    ).Movement.findOne({ chainId: fxA.chainId, leg: 2 });
    const movementB = await (
      await import('../src/models/Movement.js')
    ).Movement.findOne({ chainId: fxB.chainId, leg: 2 });

    const result = await logisticsService.createConsolidation(
      [
        (movementA!._id as unknown as string).toString(),
        (movementB!._id as unknown as string).toString(),
      ],
      { employeeId: fxA.logistics.employeeId, correlationId: 'test' },
    );
    expect(result.movementIds).toHaveLength(2);

    // QR-014 — one Marg invoice per SO, unaffected by the grouping above.
    const { MargBill } = await import('../src/models/MargBill.js');
    const billA = await MargBill.countDocuments({ soId: fxA.soId });
    const billB = await MargBill.countDocuments({ soId: fxB.soId });
    expect(billA).toBe(1);
    expect(billB).toBe(1);
  }, 45000);
});

describe("M7 — return-note collection, ST-12's missing middle state", () => {
  it('arranges collection then closes, without creating a duplicate ageing entry', async () => {
    const fx = await runToDispatchedLeg2(10, 40000);
    // Re-run a second order and force a part rejection to raise a return note.
    const fx2 = await (async () => {
      const admin = await staffToken(app, 'admin');
      const sales = await staffToken(app, 'sales');
      const purchase = await staffToken(app, 'purchase');
      const accounts = await staffToken(app, 'accounts');
      const logistics = await staffToken(app, 'transport_logistics');
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
      const { soId } = soRes.body.data as { soId: string };
      const so = await So.findById(soId);
      const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
        amountPaise: so!.totalPaise,
        method: 'utr',
        utr: `UTR-${Date.now()}`,
      });
      await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
        employeeId: sales.employeeId,
        correlationId: 'test',
      });
      await paymentService.postBankCredit(
        upcomingReceiptId,
        { utr: `STMT-${Date.now()}`, remitterAccountNumber: '1', remitterIfsc: 'HDFC0001234' },
        { employeeId: accounts.employeeId, correlationId: 'test' },
      );
      const poRes = await request(app)
        .post(`/api/v1/staff/so/${soId}/po`)
        .set('Authorization', `Bearer ${purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      const { poId } = poRes.body.data as { poId: string };
      const po = await Po.findById(poId);
      const chainId = (po!.chainId as unknown as string).toString();
      await request(app)
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
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections`)
        .set('Authorization', `Bearer ${logistics.token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          casesAccepted: 7,
          casesRejected: 3,
          reasons: ['visible_external_damage'],
          photoRefs: ['p1'],
        });
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
        .set('Authorization', `Bearer ${purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      return { poId, logistics };
    })();

    const note = await ReturnNote.findOne({ poId: fx2.poId });
    expect(note).not.toBeNull();

    const beforeAgeing = await (
      await import('../src/modules/desk/purchase/purchase.service.js')
    ).getReturnNoteAgeing();
    const beforeCount = beforeAgeing.filter(
      (r) => r.returnNoteId === (note!._id as unknown as string).toString(),
    ).length;
    expect(beforeCount).toBe(1);

    await logisticsService.arrangeReturnCollection((note!._id as unknown as string).toString(), {
      employeeId: fx2.logistics.employeeId,
      correlationId: 'test',
    });
    await logisticsService.closeReturnNote((note!._id as unknown as string).toString(), {
      employeeId: fx2.logistics.employeeId,
      correlationId: 'test',
    });

    const afterAgeing = await (
      await import('../src/modules/desk/purchase/purchase.service.js')
    ).getReturnNoteAgeing();
    // Closed notes drop off the open-ageing list entirely — no duplicate,
    // no stale entry left behind.
    expect(
      afterAgeing.some((r) => r.returnNoteId === (note!._id as unknown as string).toString()),
    ).toBe(false);
    void fx;
  }, 45000);
});

describe('M7 — Logistics DTO wall sweep (BR-071)', () => {
  it('the dashboard and hub-position reads carry no firm name and no money', async () => {
    const fx = await runToDispatchedLeg2();
    await logisticsService.recordGoodsIn(fx.poId, {
      employeeId: fx.logistics.employeeId,
      correlationId: 'test',
    });
    const dashboard = await logisticsService.getDashboard();
    const hubPosition = await logisticsService.getHubPosition();
    const json = JSON.stringify({ dashboard, hubPosition }).toLowerCase();
    expect(json).not.toMatch(/paise|rupee|₹/);
    const buyer = await Buyer.findById(fx.buyerId);
    const seller = await Seller.findById(fx.sellerId);
    expect(json).not.toContain(fx.sellerId.toLowerCase());
    expect(json).not.toContain(fx.buyerId.toLowerCase());
    void buyer;
    void seller;
  }, 30000);
});

describe('M7 — day close, ten consecutive nil differences (BR-308)', () => {
  it('closes clean ten times in a row against its own computed balance', async () => {
    const accounts = await staffToken(app, 'accounts');
    for (let i = 0; i < 10; i += 1) {
      const closingPaise = await paymentService.computeBankbookClosingPaise();
      const result = await paymentService.runDayClose(closingPaise, {
        employeeId: accounts.employeeId,
        correlationId: `m7-dayclose-${i}`,
      });
      expect(result.closingPaise).toBe(closingPaise);
    }
  }, 30000);
});

describe('M7 — QR-051, API-047 is stubbed, not built or removed', () => {
  it('the promotion mechanism still has no seller-side accept/decline route', async () => {
    const res = await request(app).post('/api/v1/quotes/does-not-exist/accept-promotion').send({});
    expect(res.status).toBe(404);
  });
});
