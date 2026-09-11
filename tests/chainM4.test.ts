import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Chain } from '../src/models/Chain.js';
import { MargBill } from '../src/models/MargBill.js';
import { Bankbook } from '../src/models/Bankbook.js';
import { PaymentRun } from '../src/models/PaymentRun.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import { signReauthToken } from '../src/shared/tokens.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

// API_CONTRACT.md §1 — every money-moving/stage-moving POST requires this
// header (middleware/idempotency.ts). Each helper call below gets its own
// fresh key — these represent distinct actions, not retries of one request.
function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

// A single seller-net rate and quantity used throughout — chosen so the
// numbers are easy to eyeball: 10 boxes, 20 base units/box, ₹400/unit
// seller net, 5% margin.
const SELLER_NET_PAISE = 40000;
const BOXES = 10;
const MARGIN_PCT = 0.05;

async function seedFixture() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');
  const controller = await staffToken(app, 'controller');
  const logistics = await staffToken(app, 'transport_logistics');

  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku();
  await seedMarginCell('B', 'Dealer', MARGIN_PCT, admin.employeeId);

  return { admin, sales, purchase, accounts, controller, logistics, buyerId, sellerId, skuId };
}

async function createSo(
  sales: { token: string },
  fixture: { buyerId: string; sellerId: string; skuId: string },
  boxes = BOXES,
) {
  const res = await request(app)
    .post('/api/v1/staff/so')
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      buyerId: fixture.buyerId,
      sellerId: fixture.sellerId,
      skuId: fixture.skuId,
      boxes,
      sellerNetPaise: SELLER_NET_PAISE,
      placeOfSupply: 'intra_state',
    });
  expect(res.status).toBe(201);
  return res.body.data as { soId: string; soNo: string };
}

async function payInFull(
  buyerId: string,
  sales: { token: string },
  accounts: { token: string },
  soId: string,
  amountPaise: number,
) {
  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
    amountPaise,
    method: 'utr',
    utr: `UTR-${Date.now()}-${Math.random()}`,
  });
  const allocateRes = await request(app)
    .post(`/api/v1/staff/upcoming-receipts/${upcomingReceiptId}/allocate`)
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ soIds: [soId] });
  expect(allocateRes.status).toBe(200);

  const postRes = await request(app)
    .post(`/api/v1/staff/bank/${upcomingReceiptId}/post`)
    .set('Authorization', `Bearer ${accounts.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      utr: `STMT-${Date.now()}-${Math.random()}`,
      remitterAccountNumber: '99988877766',
      remitterIfsc: 'HDFC0001234',
    });
  expect(postRes.status).toBe(201);
}

describe('M4 — the trade chain (DoD): one trade completes all six stages against test money', () => {
  it('runs SO -> Payment -> PO -> Leg1 -> Marg -> Dispatch end to end with correct books', async () => {
    const fixture = await seedFixture();
    const { soId, soNo } = await createSo(fixture.sales, fixture);
    void soNo;

    const so = await So.findById(soId);
    expect(so).not.toBeNull();
    const chainId = (so!.chainId as unknown as string).toString();

    // Stage 1 — SO exists.
    expect(so!.state).toBe('awaiting_payment');

    // Stage 2 — payment. Pay exactly the SO total.
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);

    // Stage 3 — PO.
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(poRes.status).toBe(201);
    const { poId } = poRes.body.data as { poId: string; poNo: string };

    let refreshedSo = await So.findById(soId);
    expect(refreshedSo!.state).toBe('po_released');

    // Leg 1 dispatch.
    const leg1Res = await request(app)
      .post(`/api/v1/staff/chains/${chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
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

    // Stage 4 — inspection (all accepted) then Purchase applies it.
    const inspectRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
    expect(inspectRes.status).toBe(201);

    const applyRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.data.soState).toBe('inspected');

    refreshedSo = await So.findById(soId);
    expect(refreshedSo!.state).toBe('inspected');

    // Stage 5 — Marg, exact match.
    const margRes = await request(app)
      .post(`/api/v1/staff/marg/${soId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: 'MARG-1',
        date: new Date().toISOString(),
        valuePaise: refreshedSo!.totalPaise,
        ewayNo: 'EWAY-1',
      });
    expect(margRes.status).toBe(201);
    expect(margRes.body.data.state).toBe('matched');

    refreshedSo = await So.findById(soId);
    expect(refreshedSo!.state).toBe('billed_in_marg');

    // Stage 6 — leg 2 dispatch.
    const leg2Res = await request(app)
      .post(`/api/v1/staff/chains/${chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
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

    refreshedSo = await So.findById(soId);
    expect(refreshedSo!.state).toBe('dispatched_leg2');
    const chain = await Chain.findById(chainId);
    expect(chain!.stage).toBe('dispatch');

    // WF-08 — the SO enters the sales register the moment leg 2 dispatches.
    const salesRegister = await paymentService.getSalesRegister();
    expect(salesRegister.some((row) => row.soId === soId)).toBe(true);

    // Books — the seller is now payable; build and release a payout.
    const payableRes = await request(app)
      .get(`/api/v1/staff/payables/${poId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`);
    expect(payableRes.body.data.payable).toBe(true);

    const buildRes = await request(app)
      .post('/api/v1/staff/payment-runs')
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ items: [{ kind: 'payout', refId: poId }] });
    expect(buildRes.status).toBe(201);
    const { paymentRunId } = buildRes.body.data as { paymentRunId: string };

    const reauthToken = signReauthToken(fixture.controller.employeeId);
    const releaseRes = await request(app)
      .post(`/api/v1/staff/payment-runs/${paymentRunId}/release`)
      .set('Authorization', `Bearer ${fixture.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .set('X-Reauth-Token', reauthToken)
      .send({});
    expect(releaseRes.status).toBe(200);

    const po = await Po.findById(poId);
    expect(po!.paid).toBe(true);

    // BR-013/INV-12 — buyer debtors compute to exactly zero.
    expect(await paymentService.totalBuyerDebtorsPaise()).toBe(0);

    // BR-308 — day close balances against the book's own computed closing.
    const closingPaise = await paymentService.computeBankbookClosingPaise();
    const dayCloseRes = await request(app)
      .post('/api/v1/staff/day-close')
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ statementClosingPaise: closingPaise });
    expect(dayCloseRes.status).toBe(200);
  }, 30000);
});

describe('INV-01 — no PO before the SO is paid in full', () => {
  it('refuses PO creation with no payment posted', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);

    const res = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SO_NOT_PAID_IN_FULL');
  });

  it('refuses PO creation on a partial payment', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise - 1);

    const res = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SO_NOT_PAID_IN_FULL');
  });

  it('Q4 — refuses a second PO against an already-paid SO', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);

    const first = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PO_ALREADY_EXISTS');
  });
});

describe('QR-007 — the pricing engine refuses to price when a matrix cell is missing', () => {
  it('MARGIN_CELL_MISSING when no cell exists for the class/tier', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    // Distributor / class C — a combination no other test in this file seeds
    // a margin cell for, so this genuinely exercises the missing-cell path
    // even though tests share one database.
    const buyerId = await createApprovedBuyer(app, sales.token, 'distributor');
    const sellerId = await createApprovedSeller(app, purchase.token);
    const skuId = await createTestSku('C');

    const res = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        buyerId,
        sellerId,
        skuId,
        boxes: 1,
        sellerNetPaise: 10000,
        placeOfSupply: 'intra_state',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MARGIN_CELL_MISSING');
  });
});

describe('BR-045 — five (+2) frozen values: a placed order never re-derives its price', () => {
  it('changing the matrix after the order does not move the already-frozen rate', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const soBefore = await So.findById(soId);
    const { SoLine } = await import('../src/models/SoLine.js');
    const lineBefore = await SoLine.findOne({ soId });

    // Raise the matrix cell's margin sharply, forward-dated to "now".
    await seedMarginCell('B', 'Dealer', 0.5, fixture.admin.employeeId);

    const soAfter = await So.findById(soId);
    const lineAfter = await SoLine.findOne({ soId });
    expect(soAfter!.totalPaise).toBe(soBefore!.totalPaise);
    expect(lineAfter!.ratePaise).toBe(lineBefore!.ratePaise);
    expect(lineAfter!.marginPctAtOrder).toBe(lineBefore!.marginPctAtOrder);
  });
});

describe('INV-04/BR-033 — nothing dispatches without a matched Marg invoice, no override', () => {
  it('refuses leg-2 dispatch when no Marg bill has been keyed at all', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    const res = await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 2,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAIN_STAGE_GUARD_FAILED');
  });

  it('INV-05 — a ₹90 Marg mismatch queries and books nothing anywhere; the chain stops', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    let so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };

    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    so = await So.findById(soId);
    const bankbookCountBefore = await Bankbook.countDocuments({});

    const margRes = await request(app)
      .post(`/api/v1/staff/marg/${soId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: 'MARG-X',
        date: new Date().toISOString(),
        valuePaise: so!.totalPaise + 9000,
        ewayNo: 'EWAY-X',
      });
    expect(margRes.status).toBe(201);
    expect(margRes.body.data.state).toBe('query');

    const soAfterQuery = await So.findById(soId);
    expect(soAfterQuery!.state).toBe('inspected'); // unchanged — the chain stopped.

    const bankbookCountAfter = await Bankbook.countDocuments({});
    expect(bankbookCountAfter).toBe(bankbookCountBefore); // books nothing anywhere.

    const dispatchRes = await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 2,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    expect(dispatchRes.status).toBe(409);
  }, 20000);
});

describe('Part rejection (Q5a/Q5b/Q6) end to end', () => {
  it('25 ordered, 22 accepted -> payout on 22, debit note for 3, SO reduced, refund raised', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture, 25);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };

    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });

    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        casesAccepted: 22,
        casesRejected: 3,
        reasons: ['visible_external_damage'],
        photoRefs: ['p1'],
      });

    const applyRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.data.soState).toBe('inspected');
    expect(applyRes.body.data.debitNoteId).toBeDefined();

    const { SellerBill } = await import('../src/models/SellerBill.js');
    const bill = await SellerBill.findOne({ poId });
    expect(bill).not.toBeNull();
    // Q5a — accepted value is strictly less than the full billed total.
    expect(bill!.acceptedValuePaise).toBeLessThan(bill!.totalPaise);

    const { Inspection } = await import('../src/models/Inspection.js');
    const inspection = await Inspection.findOne({ poId });

    // Q6 — Sales manually reduces the SO to the accepted quantity.
    const reduceRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/reduce-quantity`)
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        newBoxes: 22,
        reason: 'Part rejection — 3 boxes damaged',
        inspectionId: (inspection!._id as unknown as string).toString(),
      });
    expect(reduceRes.status).toBe(200);
    expect(reduceRes.body.data.refundId).toBeDefined();

    const { Refund } = await import('../src/models/Refund.js');
    const refund = await Refund.findById(reduceRes.body.data.refundId);
    expect(refund!.reasonCode).toBe('part_rejection_quantity_reduction');
    expect(refund!.amountPaise).toBeGreaterThan(0);

    const soAfterReduce = await So.findById(soId);
    expect(soAfterReduce!.totalPaise).toBeLessThan(so!.totalPaise);

    // Marg now matches the reduced total.
    const margRes = await request(app)
      .post(`/api/v1/staff/marg/${soId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: 'MARG-PR',
        date: new Date().toISOString(),
        valuePaise: soAfterReduce!.totalPaise,
        ewayNo: 'EWAY-PR',
      });
    expect(margRes.body.data.state).toBe('matched');
  }, 20000);

  it('Q6 — cannot reduce the SO once a Marg bill already exists', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };
    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    const refreshedSo = await So.findById(soId);
    await request(app)
      .post(`/api/v1/staff/marg/${soId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        margInvoiceNo: 'MARG-Z',
        date: new Date().toISOString(),
        valuePaise: refreshedSo!.totalPaise,
        ewayNo: 'EWAY-Z',
      });

    const { Inspection } = await import('../src/models/Inspection.js');
    const inspection = await Inspection.findOne({ poId });
    const reduceRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/reduce-quantity`)
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        newBoxes: BOXES - 1,
        reason: 'too late',
        inspectionId: (inspection!._id as unknown as string).toString(),
      });
    expect(reduceRes.status).toBe(409);
    expect(reduceRes.body.error.code).toBe('DOCUMENT_ALREADY_BILLED');
  }, 20000);
});

describe('BR-186/WF-11 — whole-lot rejection is a supply failure, not a part rejection', () => {
  it('routes straight to supply_failed with a full refund, never a part-rejection path', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };
    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });

    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: 0, casesRejected: BOXES, reasons: ['leakage'], photoRefs: ['p1'] });

    const applyRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.data.soState).toBe('supply_failed');
    expect(applyRes.body.data.refundId).toBeDefined();
    expect(applyRes.body.data.sellerBillId).toBeUndefined(); // no seller bill on a whole-lot rejection.

    const { Refund } = await import('../src/models/Refund.js');
    const refund = await Refund.findById(applyRes.body.data.refundId);
    expect(refund!.reasonCode).toBe('supply_failure_full');
    expect(refund!.amountPaise).toBe(so!.totalPaise); // BR-034 — refunded in full, never partial.

    const soAfter = await So.findById(soId);
    expect(soAfter!.state).toBe('supply_failed');
  }, 20000);
});

describe('INV-16 — a payment batch builder may never release it, whatever the role', () => {
  it('refuses when the releaser is the same employee who built it', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };
    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    const { paymentRunId } = await paymentService.buildPaymentRun(
      [{ kind: 'payout', refId: poId }],
      {
        employeeId: fixture.accounts.employeeId,
        correlationId: 'test',
      },
    );

    // The SAME accounts employee (not Controller) tries to release their own batch.
    await expect(
      paymentService.releasePaymentRun(
        paymentRunId,
        {},
        { employeeId: fixture.accounts.employeeId, correlationId: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'BUILDER_CANNOT_RELEASE' });
  }, 20000);

  it('releasing a run twice only succeeds once', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };
    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    const { paymentRunId } = await paymentService.buildPaymentRun(
      [{ kind: 'payout', refId: poId }],
      {
        employeeId: fixture.accounts.employeeId,
        correlationId: 'test',
      },
    );

    await paymentService.releasePaymentRun(
      paymentRunId,
      {},
      { employeeId: fixture.controller.employeeId, correlationId: 'test' },
    );
    await expect(
      paymentService.releasePaymentRun(
        paymentRunId,
        {},
        { employeeId: fixture.controller.employeeId, correlationId: 'test' },
      ),
    ).rejects.toThrow();

    const run = await PaymentRun.findById(paymentRunId);
    expect(run!.state).toBe('released');
  }, 20000);
});

describe('INV-17 — nothing payable to a seller with an unverified or cooling bank change', () => {
  it('refuses to build a payment run for a PO whose seller bank detail is not yet effective', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const { poId } = poRes.body.data as { poId: string };
    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        leg: 1,
        mode: 'bus',
        busNo: 'X',
        driver: 'Y',
        driverMobile: '9000000000',
        freightTerms: 'to_pay',
        freightAmountPaise: 0,
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${fixture.logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    // Put the seller's bank detail back into a cooling state (BR-017).
    const po = await Po.findById(poId);
    const { Seller } = await import('../src/models/Seller.js');
    const { BankDetail } = await import('../src/models/BankDetail.js');
    const seller = await Seller.findById(po!.sellerId);
    const detail = await BankDetail.findOne({ counterpartyId: seller!.counterpartyId }).sort({
      createdAt: -1,
    });
    detail!.effectiveFrom = new Date(Date.now() + 24 * 60 * 60 * 1000); // still cooling.
    await detail!.save();

    const buildRes = await request(app)
      .post('/api/v1/staff/payment-runs')
      .set('Authorization', `Bearer ${fixture.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ items: [{ kind: 'payout', refId: poId }] });
    expect(buildRes.status).toBe(409);
    expect(buildRes.body.error.code).toBe('BANK_CHANGE_PENDING');

    const payableRes = await request(app)
      .get(`/api/v1/staff/payables/${poId}`)
      .set('Authorization', `Bearer ${fixture.accounts.token}`);
    expect(payableRes.body.data.payable).toBe(false);
  }, 20000);
});

describe('BR-015 — reverse and repost, Controller only, never edited in place', () => {
  it('a repost creates two new entries; the original is never mutated', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(fixture.buyerId, {
      amountPaise: so!.totalPaise,
      method: 'utr',
      utr: `UTR-${Date.now()}`,
    });
    await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
      employeeId: fixture.sales.employeeId,
      correlationId: 'test',
    });
    const { bankbookId } = await paymentService.postBankCredit(
      upcomingReceiptId,
      {
        utr: `STMT-${Date.now()}`,
        remitterAccountNumber: '111222333',
        remitterIfsc: 'HDFC0001234',
      },
      { employeeId: fixture.accounts.employeeId, correlationId: 'test' },
    );
    const originalBefore = await Bankbook.findById(bankbookId);

    const reauthToken = signReauthToken(fixture.controller.employeeId);
    const repostRes = await request(app)
      .post(`/api/v1/staff/bank/${bankbookId}/repost`)
      .set('Authorization', `Bearer ${fixture.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .set('X-Reauth-Token', reauthToken)
      .send({
        reason: 'Posted to the wrong buyer',
        corrected: {
          kind: 'in',
          purpose: 'receipt',
          partyId: fixture.buyerId,
          partyType: 'buyer',
          amountPaise: so!.totalPaise,
        },
      });
    expect(repostRes.status).toBe(201);

    const originalAfter = await Bankbook.findById(bankbookId);
    expect(originalAfter!.amountPaise).toBe(originalBefore!.amountPaise);
    expect(originalAfter!.kind).toBe(originalBefore!.kind); // never edited in place.

    const reversal = await Bankbook.findById(repostRes.body.data.reversalId);
    expect(reversal!.reversalOf!.toString()).toBe(bankbookId);
    expect(reversal!.kind).toBe('out'); // opposite of the original 'in'.
  }, 20000);

  it('requires re-authentication — no X-Reauth-Token is refused', async () => {
    const fixture = await seedFixture();
    const res = await request(app)
      .post('/api/v1/staff/bank/000000000000000000000000/repost')
      .set('Authorization', `Bearer ${fixture.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        reason: 'x',
        corrected: {
          kind: 'in',
          purpose: 'receipt',
          partyId: fixture.buyerId,
          partyType: 'buyer',
          amountPaise: 100,
        },
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });
});

describe('Concurrency', () => {
  it('two payments posted against one SO simultaneously both post, and PO creation sees the sum', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    const half = Math.ceil(so!.totalPaise / 2);

    const [r1, r2] = await Promise.all([
      paymentService.createUpcomingReceipt(fixture.buyerId, {
        amountPaise: half,
        method: 'utr',
        utr: `A-${Date.now()}`,
      }),
      paymentService.createUpcomingReceipt(fixture.buyerId, {
        amountPaise: so!.totalPaise - half,
        method: 'utr',
        utr: `B-${Date.now()}`,
      }),
    ]);
    await Promise.all([
      paymentService.allocateUpcomingReceipt(r1.upcomingReceiptId, [soId], {
        employeeId: fixture.sales.employeeId,
        correlationId: 't',
      }),
      paymentService.allocateUpcomingReceipt(r2.upcomingReceiptId, [soId], {
        employeeId: fixture.sales.employeeId,
        correlationId: 't',
      }),
    ]);
    await Promise.all([
      paymentService.postBankCredit(
        r1.upcomingReceiptId,
        { utr: `S1-${Date.now()}`, remitterAccountNumber: '1', remitterIfsc: 'HDFC0001234' },
        { employeeId: fixture.accounts.employeeId, correlationId: 't' },
      ),
      paymentService.postBankCredit(
        r2.upcomingReceiptId,
        { utr: `S2-${Date.now()}`, remitterAccountNumber: '2', remitterIfsc: 'HDFC0001234' },
        { employeeId: fixture.accounts.employeeId, correlationId: 't' },
      ),
    ]);

    const posted = await paymentService.getPostedReceiptsPaiseForSo(soId);
    expect(posted).toBe(so!.totalPaise);

    const poRes = await request(app)
      .post(`/api/v1/staff/so/${soId}/po`)
      .set('Authorization', `Bearer ${fixture.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(poRes.status).toBe(201);
  }, 20000);

  it('a PO is created twice from one paid SO only once — the second is rejected', async () => {
    const fixture = await seedFixture();
    const { soId } = await createSo(fixture.sales, fixture);
    const so = await So.findById(soId);
    await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);

    const [a, b] = await Promise.allSettled([
      request(app)
        .post(`/api/v1/staff/so/${soId}/po`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({}),
      request(app)
        .post(`/api/v1/staff/so/${soId}/po`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({}),
    ]);
    const statuses = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(1);

    const poCount = await Po.countDocuments({ soId });
    expect(poCount).toBe(1);
  }, 20000);
});

describe('Marg tolerance — INV-05/BR-033, boundary behaviour', () => {
  it('matches at exactly ₹5 off and queries at ₹5.01 off', async () => {
    const fixture = await seedFixture();

    for (const [offset, expectedState] of [
      [500, 'matched'],
      [501, 'query'],
    ] as const) {
      const { soId } = await createSo(fixture.sales, fixture);
      const so = await So.findById(soId);
      await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
      const poRes = await request(app)
        .post(`/api/v1/staff/so/${soId}/po`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      const { poId } = poRes.body.data as { poId: string };
      await request(app)
        .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
        .set('Authorization', `Bearer ${fixture.logistics.token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          leg: 1,
          mode: 'bus',
          busNo: 'X',
          driver: 'Y',
          driverMobile: '9000000000',
          freightTerms: 'to_pay',
          freightAmountPaise: 0,
        });
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections`)
        .set('Authorization', `Bearer ${fixture.logistics.token}`)
        .set('Idempotency-Key', idemKey())
        .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});

      const refreshedSo = await So.findById(soId);
      const margRes = await request(app)
        .post(`/api/v1/staff/marg/${soId}`)
        .set('Authorization', `Bearer ${fixture.accounts.token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          margInvoiceNo: `M-${offset}`,
          date: new Date().toISOString(),
          valuePaise: refreshedSo!.totalPaise + offset,
          ewayNo: `E-${offset}`,
        });
      expect(margRes.body.data.state).toBe(expectedState);
    }
  }, 30000);
});

describe('Idempotency-Key — API_CONTRACT.md §1, MASTER_PLAN.md §M4 item 10', () => {
  it('is required on a money-moving POST', async () => {
    const fixture = await seedFixture();
    const res = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .send({
        buyerId: fixture.buyerId,
        sellerId: fixture.sellerId,
        skuId: fixture.skuId,
        boxes: 1,
        sellerNetPaise: SELLER_NET_PAISE,
        placeOfSupply: 'intra_state',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('replays the original response on a retry with the same key and body, without creating a second SO', async () => {
    const fixture = await seedFixture();
    const key = idemKey();
    const body = {
      buyerId: fixture.buyerId,
      sellerId: fixture.sellerId,
      skuId: fixture.skuId,
      boxes: 1,
      sellerNetPaise: SELLER_NET_PAISE,
      placeOfSupply: 'intra_state',
    };

    const first = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.data.soId).toBe(first.body.data.soId);

    expect(await So.countDocuments({ soNo: first.body.data.soNo })).toBe(1);
  });

  it('refuses the same key reused with a different body', async () => {
    const fixture = await seedFixture();
    const key = idemKey();
    const baseBody = {
      buyerId: fixture.buyerId,
      sellerId: fixture.sellerId,
      skuId: fixture.skuId,
      boxes: 1,
      sellerNetPaise: SELLER_NET_PAISE,
      placeOfSupply: 'intra_state' as const,
    };

    const first = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', key)
      .send(baseBody);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/staff/so')
      .set('Authorization', `Bearer ${fixture.sales.token}`)
      .set('Idempotency-Key', key)
      .send({ ...baseBody, boxes: 2 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('MargBill — exactly one matched bill per SO (Q14)', () => {
  it('never consolidated — a second SO needs its own Marg bill', async () => {
    const fixture = await seedFixture();
    const { soId: soId1 } = await createSo(fixture.sales, fixture);
    const { soId: soId2 } = await createSo(fixture.sales, fixture);
    expect(soId1).not.toBe(soId2);

    for (const soId of [soId1, soId2]) {
      const so = await So.findById(soId);
      await payInFull(fixture.buyerId, fixture.sales, fixture.accounts, soId, so!.totalPaise);
      const poRes = await request(app)
        .post(`/api/v1/staff/so/${soId}/po`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      const { poId } = poRes.body.data as { poId: string };
      await request(app)
        .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
        .set('Authorization', `Bearer ${fixture.logistics.token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          leg: 1,
          mode: 'bus',
          busNo: 'X',
          driver: 'Y',
          driverMobile: '9000000000',
          freightTerms: 'to_pay',
          freightAmountPaise: 0,
        });
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections`)
        .set('Authorization', `Bearer ${fixture.logistics.token}`)
        .set('Idempotency-Key', idemKey())
        .send({ casesAccepted: BOXES, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
      await request(app)
        .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
        .set('Authorization', `Bearer ${fixture.purchase.token}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      const refreshedSo = await So.findById(soId);
      const res = await request(app)
        .post(`/api/v1/staff/marg/${soId}`)
        .set('Authorization', `Bearer ${fixture.accounts.token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          margInvoiceNo: `M-${soId}`,
          date: new Date().toISOString(),
          valuePaise: refreshedSo!.totalPaise,
          ewayNo: `E-${soId}`,
        });
      expect(res.body.data.state).toBe('matched');
    }

    expect(await MargBill.countDocuments({ soId: soId1, state: 'matched' })).toBe(1);
    expect(await MargBill.countDocuments({ soId: soId2, state: 'matched' })).toBe(1);
  }, 30000);
});
