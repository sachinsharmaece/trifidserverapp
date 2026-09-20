import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { SoLine } from '../src/models/SoLine.js';
import { Po } from '../src/models/Po.js';
import { MargBill } from '../src/models/MargBill.js';
import { Bankbook } from '../src/models/Bankbook.js';
import { SellerBill } from '../src/models/SellerBill.js';
import { AuditLog } from '../src/models/AuditLog.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import * as margService from '../src/modules/marg/marg.service.js';
import { signReauthToken } from '../src/shared/tokens.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

/**
 * Milestone 9 — the invariant suite's gap closers. Each block names the PRD §6
 * invariant it proves (docs/invariant-coverage.md is the index) and every one
 * has a failing path, not only a happy path (CH §25.6).
 */
const app = createApp();

function idemKey(): string {
  return `m9-${Date.now()}-${Math.random()}`;
}

async function seedFixture() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');
  const controller = await staffToken(app, 'controller');
  const logistics = await staffToken(app, 'transport_logistics');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const otherBuyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku();
  await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);
  return {
    sales,
    purchase,
    accounts,
    controller,
    logistics,
    buyerId,
    otherBuyerId,
    sellerId,
    skuId,
  };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function createSo(fx: Fixture, buyerId: string, boxes = 10) {
  const res = await request(app)
    .post('/api/v1/staff/so')
    .set('Authorization', `Bearer ${fx.sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({
      buyerId,
      sellerId: fx.sellerId,
      skuId: fx.skuId,
      boxes,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    });
  expect(res.status).toBe(201);
  return res.body.data as { soId: string };
}

async function claim(buyerId: string, amountPaise: number): Promise<string> {
  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
    amountPaise,
    method: 'utr',
    utr: `UTR-${Math.random()}`,
  });
  return upcomingReceiptId;
}

async function post(fx: Fixture, receiptId: string): Promise<void> {
  await paymentService.postBankCredit(
    receiptId,
    {
      utr: `STMT-${Math.random()}`,
      remitterAccountNumber: '99988877766',
      remitterIfsc: 'HDFC0001234',
    },
    { employeeId: fx.accounts.employeeId, correlationId: 'm9' },
  );
}

async function payInFull(fx: Fixture, buyerId: string, soId: string): Promise<void> {
  const so = await So.findById(soId);
  const receiptId = await claim(buyerId, so!.totalPaise);
  await paymentService.allocateUpcomingReceipt(receiptId, [soId], {
    employeeId: fx.sales.employeeId,
    correlationId: 'm9',
  });
  await post(fx, receiptId);
}

async function releasePo(fx: Fixture, soId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/staff/so/${soId}/po`)
    .set('Authorization', `Bearer ${fx.purchase.token}`)
    .set('Idempotency-Key', idemKey())
    .send({});
  expect(res.status).toBe(201);
  return res.body.data.poId as string;
}

describe('INV-14 — no receipt is allocated to another party’s order', () => {
  it('refuses to allocate buyer A’s receipt to buyer B’s SO, and leaves the claim waiting', async () => {
    const fx = await seedFixture();
    const { soId: theirSoId } = await createSo(fx, fx.otherBuyerId);
    const theirSo = await So.findById(theirSoId);
    const receiptId = await claim(fx.buyerId, theirSo!.totalPaise);

    await expect(
      paymentService.allocateUpcomingReceipt(receiptId, [theirSoId], {
        employeeId: fx.sales.employeeId,
        correlationId: 'm9',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Nothing was stored, so posting it is refused too — the money cannot reach his SO.
    await expect(
      paymentService.postBankCredit(
        receiptId,
        { utr: 'X', remitterAccountNumber: '1', remitterIfsc: 'HDFC0001234' },
        { employeeId: fx.accounts.employeeId, correlationId: 'm9' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await paymentService.getPostedReceiptsPaiseForSo(theirSoId)).toBe(0);
  });

  it('refuses a mixed allocation (one own SO, one someone else’s) and an unknown SO id', async () => {
    const fx = await seedFixture();
    const { soId: mine } = await createSo(fx, fx.buyerId);
    const { soId: theirs } = await createSo(fx, fx.otherBuyerId);
    const receiptId = await claim(fx.buyerId, 1000);
    const actor = { employeeId: fx.sales.employeeId, correlationId: 'm9' };

    await expect(
      paymentService.allocateUpcomingReceipt(receiptId, [mine, theirs], actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      paymentService.allocateUpcomingReceipt(receiptId, ['000000000000000000000000'], actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // And his own SO is still allocatable — the guard refuses only what it must.
    await expect(
      paymentService.allocateUpcomingReceipt(receiptId, [mine], actor),
    ).resolves.toBeUndefined();
  });
});

describe('INV-01 / QR-057 — one receipt must not pay two orders', () => {
  // KNOWN DEFECT, documented rather than hidden. `getPostedReceiptsPaiseForSo`
  // sums the WHOLE receipt for every SO it lists, and the receipt carries no
  // per-SO amount, so a single receipt allocated to two SOs of the same buyer
  // satisfies INV-01 for both. How a multi-SO receipt is apportioned is a
  // business rule the register does not give us (QR-057). This test asserts the
  // defect AS IT STANDS, so it is green today and turns RED the moment the
  // defect is fixed — at which point flip the last assertion to `toBeLessThanOrEqual(1)`.
  it('DEFECT (QR-057): one SO’s worth of money, allocated to two SOs, releases BOTH POs', async () => {
    const fx = await seedFixture();
    const { soId: a } = await createSo(fx, fx.buyerId);
    const { soId: b } = await createSo(fx, fx.buyerId);
    const soA = await So.findById(a);
    const receiptId = await claim(fx.buyerId, soA!.totalPaise); // one SO's worth of money
    await paymentService.allocateUpcomingReceipt(receiptId, [a, b], {
      employeeId: fx.sales.employeeId,
      correlationId: 'm9',
    });
    await post(fx, receiptId);

    const first = await request(app)
      .post(`/api/v1/staff/so/${a}/po`)
      .set('Authorization', `Bearer ${fx.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    const second = await request(app)
      .post(`/api/v1/staff/so/${b}/po`)
      .set('Authorization', `Bearer ${fx.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    // Correct behaviour would be: at most one of the two can be released.
    expect([first.status, second.status]).toEqual([201, 201]);
  });
});

describe('INV-07 / INV-26 — the PO edit path', () => {
  async function poFor(fx: Fixture) {
    const { soId } = await createSo(fx, fx.buyerId);
    await payInFull(fx, fx.buyerId, soId);
    const poId = await releasePo(fx, soId);
    const soLine = await SoLine.findOne({ soId });
    return { soId, poId, soRatePaise: soLine!.ratePaise };
  }
  const edit = (fx: Fixture, poId: string, body: object) =>
    request(app)
      .post(`/api/v1/staff/po/${poId}/edit`)
      .set('Authorization', `Bearer ${fx.purchase.token}`)
      .send(body);

  it('INV-07 — refuses an edit that lifts the PO rate above the SO rate; allows one at or below it', async () => {
    const fx = await seedFixture();
    const { poId, soRatePaise } = await poFor(fx);

    const above = await edit(fx, poId, { field: 'rate', to: soRatePaise + 1, reason: 'x' });
    expect(above.status).toBe(409);
    expect(above.body.error.code).toBe('CHAIN_STAGE_GUARD_FAILED');

    const atCeiling = await edit(fx, poId, { field: 'rate', to: soRatePaise, reason: 'x' });
    expect(atCeiling.status).toBeLessThan(300);
    const lower = await edit(fx, poId, { field: 'rate', to: 39000, reason: 'x' });
    expect(lower.status).toBeLessThan(300);
  }, 30000);

  it('INV-26 — refuses any edit once the PO is billed, and any field other than rate or quantity', async () => {
    const fx = await seedFixture();
    const { poId } = await poFor(fx);

    const other = await edit(fx, poId, { field: 'sellerId', to: 1, reason: 'x' });
    expect(other.status).toBe(400); // only rate and qty are editable at all
    const extra = await edit(fx, poId, { field: 'rate', to: 39000, reason: 'x', poNo: 'PO-9' });
    expect(extra.status).toBe(400); // unknown fields rejected, not ignored

    await Po.updateOne({ _id: poId }, { $set: { billed: true } });
    const afterBilling = await edit(fx, poId, { field: 'rate', to: 39000, reason: 'x' });
    expect(afterBilling.status).toBe(409);
    expect(afterBilling.body.error.code).toBe('DOCUMENT_ALREADY_BILLED');
  }, 30000);
});

describe('INV-02 / INV-03 — no Marg billing before full payment or before leg 1 is complete', () => {
  const marg = (soId: string, fx: Fixture) =>
    margService.keyMargInvoice(
      soId,
      { margInvoiceNo: `M-${Math.random()}`, date: new Date(), valuePaise: 1, ewayNo: 'E' },
      { employeeId: fx.accounts.employeeId, correlationId: 'm9' },
    );

  it('refuses to key a Marg bill on an unpaid SO, and books nothing', async () => {
    const fx = await seedFixture();
    const { soId } = await createSo(fx, fx.buyerId);
    await expect(marg(soId, fx)).rejects.toMatchObject({ code: 'CHAIN_STAGE_GUARD_FAILED' });
    expect(await MargBill.countDocuments({ soId })).toBe(0);
  });

  it('refuses on a paid SO whose leg 1 / inspection has not happened, and books nothing', async () => {
    const fx = await seedFixture();
    const { soId } = await createSo(fx, fx.buyerId);
    await payInFull(fx, fx.buyerId, soId);
    await releasePo(fx, soId);
    expect((await So.findById(soId))!.state).toBe('po_released');
    await expect(marg(soId, fx)).rejects.toMatchObject({ code: 'CHAIN_STAGE_GUARD_FAILED' });
    expect(await MargBill.countDocuments({ soId })).toBe(0);
  }, 30000);
});

describe('INV-13 — an outward payment equals the seller’s accepted bill total on its PO', () => {
  it('a 22-of-25 part rejection pays exactly the accepted value, not the billed one', async () => {
    const fx = await seedFixture();
    const { soId } = await createSo(fx, fx.buyerId, 25);
    await payInFull(fx, fx.buyerId, soId);
    const poId = await releasePo(fx, soId);
    const so = await So.findById(soId);
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

    await request(app)
      .post(`/api/v1/staff/chains/${so!.chainId}/movements`)
      .set(auth(fx.logistics.token))
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
      .set(auth(fx.logistics.token))
      .set('Idempotency-Key', idemKey())
      .send({
        casesAccepted: 22,
        casesRejected: 3,
        reasons: ['visible_external_damage'],
        photoRefs: ['p1'],
      });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set(auth(fx.purchase.token))
      .set('Idempotency-Key', idemKey())
      .send({});

    const bill = await SellerBill.findOne({ poId });
    expect(bill!.acceptedValuePaise).toBeLessThan(bill!.totalPaise);

    const build = await request(app)
      .post('/api/v1/staff/payment-runs')
      .set(auth(fx.accounts.token))
      .set('Idempotency-Key', idemKey())
      .send({ items: [{ kind: 'payout', refId: poId }] });
    expect(build.status).toBe(201);
    const release = await request(app)
      .post(`/api/v1/staff/payment-runs/${build.body.data.paymentRunId}/release`)
      .set(auth(fx.controller.token))
      .set('X-Reauth-Token', signReauthToken(fx.controller.employeeId))
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(release.status).toBe(200);

    const payouts = await Bankbook.find({ kind: 'out', purpose: 'payout', partyId: fx.sellerId });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.amountPaise).toBe(bill!.acceptedValuePaise);

    // INV-11 — the seller's ledger: bills booked − payments made, recomputed from the raw rows.
    // (Booked at the accepted value, Q5a — so paying exactly that leaves the ledger at zero.)
    const seller = await paymentService.computeSellerLedgerPaise(fx.sellerId);
    const booked = await SellerBill.find({ poId, booked: true });
    const paid = await Bankbook.find({ partyId: fx.sellerId, kind: 'out', purpose: 'payout' });
    expect(seller).toBe(
      booked.reduce((t, b) => t + b.acceptedValuePaise, 0) -
        paid.reduce((t, p) => t + p.amountPaise, 0),
    );
    expect(seller).toBe(0);
  }, 60000);
});

describe('INV-15 — an upcoming receipt appears in no bank line and no ledger', () => {
  it('a claimed-but-unposted receipt moves neither the bank book nor the buyer’s ledger', async () => {
    const fx = await seedFixture();
    await createSo(fx, fx.buyerId);
    const ledgerBefore = await paymentService.computeBuyerLedgerPaise(fx.buyerId);
    const closingBefore = await paymentService.computeBankbookClosingPaise();
    const linesBefore = await Bankbook.countDocuments({ partyId: fx.buyerId });

    await claim(fx.buyerId, 555500); // a claim, not a credit

    expect(await paymentService.computeBuyerLedgerPaise(fx.buyerId)).toBe(ledgerBefore);
    expect(await paymentService.computeBankbookClosingPaise()).toBe(closingBefore);
    expect(await Bankbook.countDocuments({ partyId: fx.buyerId })).toBe(linesBefore);
  });
});

describe('INV-10 / INV-11 — ledgers are computed, and add up from the raw records', () => {
  it('the sum of buyer ledgers equals openings + matched Marg bills − net receipts, recomputed independently', async () => {
    const fx = await seedFixture();
    const { soId } = await createSo(fx, fx.buyerId);
    await payInFull(fx, fx.buyerId, soId);
    await createSo(fx, fx.otherBuyerId); // unpaid: contributes nothing

    const buyers = [fx.buyerId, fx.otherBuyerId];
    let fromLedgers = 0;
    let fromRaw = 0;
    for (const buyerId of buyers) {
      fromLedgers += await paymentService.computeBuyerLedgerPaise(buyerId);
      const soIds = (await So.find({ buyerId }).select('_id')).map((s) => s._id);
      const bills = await MargBill.find({ soId: { $in: soIds }, state: 'matched' });
      const receipts = await Bankbook.find({ partyId: buyerId, kind: 'in', purpose: 'receipt' });
      fromRaw +=
        bills.reduce((t, b) => t + b.valuePaise, 0) -
        receipts.reduce((t, r) => t + r.amountPaise, 0);
    }
    expect(fromLedgers).toBe(fromRaw);
    expect(fromRaw).toBeLessThan(0); // money held, never a debtor
    expect(await paymentService.totalBuyerDebtorsPaise()).toBe(0);
  }, 30000);

  it('INV-12, failing path — a buyer billed without paying IS a debtor, and the alarm total is no longer zero', async () => {
    const fx = await seedFixture();
    const { soId } = await createSo(fx, fx.buyerId);
    const so = (await So.findById(soId))!;
    const before = await paymentService.totalBuyerDebtorsPaise();
    // A matched Marg bill with no receipt posted: what a bypass of the payment gate would leave.
    await MargBill.create({
      margInvoiceNo: `M9-DEBTOR-${Math.random()}`,
      soId: so._id,
      placeOfSupply: 'intra_state',
      taxSplit: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
      valuePaise: so.totalPaise,
      ewayNo: 'E',
      state: 'matched',
      keyedBy: fx.accounts.employeeId,
      keyedAt: new Date(),
    });
    expect(await paymentService.computeBuyerLedgerPaise(fx.buyerId)).toBe(so.totalPaise);
    expect(await paymentService.totalBuyerDebtorsPaise()).toBe(before + so.totalPaise);
  }, 30000);
});

describe('INV-09 — the bank book must equal the statement to close the day', () => {
  it('refuses a day close that is one paisa out, and writes no day-close audit entry', async () => {
    const fx = await seedFixture();
    const computed = await paymentService.computeBankbookClosingPaise();
    const before = await AuditLog.countDocuments({ entity: 'day_close' });

    const res = await request(app)
      .post('/api/v1/staff/day-close')
      .set('Authorization', `Bearer ${fx.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ statementClosingPaise: computed + 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DAY_CLOSE_OUT_OF_BALANCE');
    expect(await AuditLog.countDocuments({ entity: 'day_close' })).toBe(before);

    const ok = await request(app)
      .post('/api/v1/staff/day-close')
      .set('Authorization', `Bearer ${fx.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ statementClosingPaise: computed });
    expect(ok.status).toBe(200);
  });
});

describe('INV-23 — every classified account has exactly one owner', () => {
  it('assigning a buyer a second time never adds a second owner, and never answers 500', async () => {
    const admin = await staffToken(app, 'admin');
    const first = await staffToken(app, 'sales');
    const second = await staffToken(app, 'sales');
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const assign = (ownerEmployeeId: string) =>
      request(app)
        .post('/api/v1/admin/book-assignments')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ buyerId, ownerEmployeeId });

    expect((await assign(first.employeeId)).status).toBe(201);
    const again = await assign(second.employeeId);
    expect(again.status).toBeLessThan(500); // a refusal or a replacement, never an unhandled duplicate key

    const { BookAssignment } = await import('../src/models/BookAssignment.js');
    expect(await BookAssignment.countDocuments({ buyerId })).toBe(1);
  }, 30000);

  it('a lane can have only one holder at the database level — a second allocation cannot be written', async () => {
    const { LaneAllocation } = await import('../src/models/LaneAllocation.js');
    const { Lane } = await import('../src/models/Lane.js');
    await LaneAllocation.init(); // the unique index must exist before we lean on it
    const lane = (await Lane.findOne())!;
    await LaneAllocation.deleteMany({ laneKey: lane.key });
    const { Types } = await import('mongoose');
    await LaneAllocation.create({ laneKey: lane.key, employeeId: new Types.ObjectId() });
    await expect(
      LaneAllocation.create({ laneKey: lane.key, employeeId: new Types.ObjectId() }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await LaneAllocation.countDocuments({ laneKey: lane.key })).toBe(1);
  }, 30000);
});

describe('INV-25 / CH §24.2 — repost and release are Controller-gated and re-authenticated', () => {
  it('INV-25 — Accounts, Sales and Purchase are refused a bank repost even holding a valid re-auth token', async () => {
    const fx = await seedFixture();
    for (const who of [fx.accounts, fx.sales, fx.purchase]) {
      const res = await request(app)
        .post('/api/v1/staff/bank/000000000000000000000000/repost')
        .set('Authorization', `Bearer ${who.token}`)
        .set('X-Reauth-Token', signReauthToken(who.employeeId))
        .set('Idempotency-Key', idemKey())
        .send({
          reason: 'x',
          corrected: {
            kind: 'in',
            purpose: 'receipt',
            partyId: fx.buyerId,
            partyType: 'buyer',
            amountPaise: 1,
          },
        });
      expect(res.status).toBe(403);
    }
  });

  it('INV-16 — releasing a payment run without a re-auth token is refused with REAUTH_REQUIRED', async () => {
    const fx = await seedFixture();
    const res = await request(app)
      .post('/api/v1/staff/payment-runs/000000000000000000000000/release')
      .set('Authorization', `Bearer ${fx.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('a re-auth token issued to someone else, or a plain access token, is not accepted', async () => {
    const fx = await seedFixture();
    const forOther = signReauthToken(fx.accounts.employeeId);
    const stolen = await request(app)
      .post('/api/v1/staff/payment-runs/000000000000000000000000/release')
      .set('Authorization', `Bearer ${fx.controller.token}`)
      .set('X-Reauth-Token', forOther)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(stolen.status).toBe(401);
    const accessAsReauth = await request(app)
      .post('/api/v1/staff/payment-runs/000000000000000000000000/release')
      .set('Authorization', `Bearer ${fx.controller.token}`)
      .set('X-Reauth-Token', fx.controller.token)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(accessAsReauth.status).toBe(401);
  });
});
