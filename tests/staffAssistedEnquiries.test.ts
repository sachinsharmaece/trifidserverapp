import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Po } from '../src/models/Po.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Tehsil } from '../src/models/Tehsil.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';
import { randomMobile, randomGstin } from './helpers.js';
import { findWallViolations, type Identity } from './wallSweepRules.js';

const app = createApp();

function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

function bankDetail() {
  return {
    accountNumber: `${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    ifsc: 'HDFC0001234',
    accountName: 'Test Account',
  };
}

function consent() {
  return { noticeVersion: 'v1', marketingOptIn: false };
}

async function counterpartyIdOfBuyer(buyerId: string): Promise<string> {
  return (await Buyer.findById(buyerId))!.counterpartyId!.toString();
}

async function counterpartyIdOfSeller(sellerId: string): Promise<string> {
  return (await Seller.findById(sellerId))!.counterpartyId!.toString();
}

async function identityOf(kind: 'buyer' | 'seller', docId: string): Promise<Identity> {
  const doc = kind === 'buyer' ? await Buyer.findById(docId) : await Seller.findById(docId);
  const cp = await Counterparty.findById(doc!.counterpartyId);
  return {
    ids: [docId, String(cp!._id)],
    strings: [cp!.firm, cp!.gstin, cp!.mobile].filter((s): s is string => !!s),
  };
}

describe('Staff-assisted registration — the OTP gate (client decision A)', () => {
  // Buyer is carved out of this gate temporarily — see the dedicated test
  // below and onboarding.service.ts's approveBuyer (TEMP, 2026-09-28).
  it('seller cannot be approved without a completed OTP confirmation, even with every other field correct', async () => {
    const purchase = await staffToken(app, 'purchase');
    const mobile = randomMobile();

    const registerRes = await request(app)
      .post('/api/v1/staff/registrations/seller')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        mobile,
        firm: 'Phone Seller Firm',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'MP/IND/INS/2016/0771',
        references: [
          {
            firm: 'Ref One',
            phone: '9000000001',
            relationship: 'Supplier',
            whatTheySaid: 'Reliable',
          },
          {
            firm: 'Ref Two',
            phone: '9000000002',
            relationship: 'Supplier',
            whatTheySaid: 'Reliable',
          },
        ],
        bankDetail: bankDetail(),
        consent: consent(),
        callNote: 'Called in asking to register, quoted GSTIN over the phone.',
      });
    expect(registerRes.status).toBe(201);
    const { registrationId } = registerRes.body.data as { registrationId: string };

    const counterparty = await Counterparty.findById(registrationId);
    expect(counterparty!.staffAssisted).toBe(true);
    expect(counterparty!.staffAssistedCallNote).toContain('quoted GSTIN');

    const tehsil = await Tehsil.create({
      name: `Tehsil ${Date.now()}-${Math.random()}`,
      district: 'D',
      state: 'MP',
    });

    // Every field correct — area and dispatch cutoff set — but no OTP yet.
    const approveBeforeOtp = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        tehsilIds: [(tehsil._id as unknown as string).toString()],
        dispatchCutoffTime: '18:00',
      });
    expect(approveBeforeOtp.status).toBe(409);
    expect(approveBeforeOtp.body.error.code).toBe('OTP_CONFIRMATION_REQUIRED');

    // The same, unmodified OTP mechanism confirms the real phone number.
    const otpRequestRes = await request(app).post('/api/v1/auth/otp/request').send({ mobile });
    const { requestId, devCode } = otpRequestRes.body.data as {
      requestId: string;
      devCode: string;
    };
    const otpVerifyRes = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ requestId, code: devCode, deviceFingerprint: 'device-registration-confirm' });
    expect(otpVerifyRes.status).toBe(200);

    const confirmed = await Counterparty.findById(registrationId);
    expect(confirmed!.staffAssistedOtpVerifiedAt).toBeTruthy();

    const approveAfterOtp = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        tehsilIds: [(tehsil._id as unknown as string).toString()],
        dispatchCutoffTime: '18:00',
      });
    expect(approveAfterOtp.status).toBe(200);
  });

  // TEMP (2026-09-28): buyer's OTP gate is disabled at product's request — see
  // onboarding.service.ts's approveBuyer. This test asserts the current,
  // temporary behaviour, and should fail loudly (reminding to update it) once
  // the gate is restored.
  it('buyer approves fine without an OTP confirmation, while the gate is temporarily off', async () => {
    const sales = await staffToken(app, 'sales');
    const mobile = randomMobile();

    const registerRes = await request(app)
      .post('/api/v1/staff/registrations/buyer')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        mobile,
        firm: 'Phone Firm',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'LIC-9',
        gstPpobAddress: 'Address',
        bankDetail: bankDetail(),
        consent: consent(),
        callNote: 'Called in asking to register, quoted GSTIN over the phone.',
      });
    expect(registerRes.status).toBe(201);
    const { registrationId } = registerRes.body.data as { registrationId: string };

    const counterparty = await Counterparty.findById(registrationId);
    expect(counterparty!.staffAssistedOtpVerifiedAt).toBeFalsy();

    const tehsil = await Tehsil.create({
      name: `Tehsil ${Date.now()}-${Math.random()}`,
      district: 'D',
      state: 'MP',
    });

    const approveBeforeOtp = await request(app)
      .post(`/api/v1/staff/registrations/${registrationId}/approve`)
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        tehsilId: (tehsil._id as unknown as string).toString(),
        tradePosition: 'dealer',
        isTrader: false,
      });
    expect(approveBeforeOtp.status).toBe(200);
  });

  it('desk boundary — Purchase cannot raise a staff-assisted buyer registration', async () => {
    const purchase = await staffToken(app, 'purchase');
    const res = await request(app)
      .post('/api/v1/staff/registrations/buyer')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        mobile: randomMobile(),
        firm: 'X',
        gstin: await randomGstin(),
        ownerName: 'Owner',
        licenceNo: 'LIC-1',
        gstPpobAddress: 'Address',
        bankDetail: bankDetail(),
        consent: consent(),
        callNote: 'note',
      });
    expect(res.status).toBe(403);
  });
});

describe('Buyer-side proxy actions (Sales desk)', () => {
  it('"log a buyer call" produces an identical record to a real ask — same validation, no price field, call note on the Ask', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyIdOfBuyer(buyerId);
    const skuId = await createTestSku('Medium');

    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId,
        skuId,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'Buyer called asking for 5 boxes, no specific rate discussed.',
      });
    expect(res.status).toBe(201);
    const { askId } = res.body.data as { askId: string };

    const ask = await Ask.findById(askId);
    expect(ask!.buyerId!.toString()).toBe(buyerId);
    expect(ask!.proxyLog).toHaveLength(1);
    expect(ask!.proxyLog![0]!.action).toBe('raise_ask');
    expect(ask!.proxyLog![0]!.callNote).toContain('5 boxes');
    expect(ask!.proxyLog![0]!.actingStaffId!.toString()).toBe(sales.employeeId);

    // BR-121 — a price field is refused exactly as the real POST /asks refuses it.
    const priceRes = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId,
        skuId,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        ratePaise: 10000,
        callNote: 'note',
      });
    expect(priceRes.status).toBe(400);
  });

  it('one call naming several products raises one ask per product, each with the call note; a bad line fails alone', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyIdOfBuyer(buyerId);
    const skuOne = await createTestSku('Medium');
    const skuTwo = await createTestSku('Medium');
    const post = (body: object) =>
      request(app)
        .post('/api/v1/staff/proxy/buyer/asks/batch')
        .set('Authorization', `Bearer ${sales.token}`)
        .send(body);
    const line = (skuId: string, qty: number) => ({
      skuId,
      qty,
      conditionRequirement: { expiryBand: 'over12' },
    });

    const res = await post({
      buyerCounterpartyId,
      callNote: 'Buyer called wanting two products in one go.',
      lines: [line(skuOne, 3), line(skuTwo, 7)],
    });
    expect(res.status).toBe(201);
    const results = res.body.data.results as Array<{ index: number; askId?: string }>;
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    const asks = await Ask.find({ _id: { $in: results.map((r) => r.askId) } });
    expect(asks).toHaveLength(2);
    expect(asks.map((a) => a.qty).sort()).toEqual([3, 7]);
    for (const ask of asks) {
      expect(ask.buyerId!.toString()).toBe(buyerId);
      expect(ask.proxyLog![0]!.callNote).toContain('two products');
      expect(ask.proxyLog![0]!.actingStaffId!.toString()).toBe(sales.employeeId);
    }

    // A line with neither a SKU nor a product is refused on its own — the good line still saves.
    const mixed = await post({
      buyerCounterpartyId,
      callNote: 'Second call, one line missing its product.',
      lines: [line(skuOne, 2), { qty: 1, conditionRequirement: { expiryBand: 'over12' } }],
    });
    expect(mixed.status).toBe(201);
    const mixedResults = mixed.body.data.results as Array<{ askId?: string; error?: string }>;
    expect(mixedResults[0]!.askId).toBeTruthy();
    expect(mixedResults[1]!.error).toMatch(/SKU or a product/);

    // A price field is refused outright (BR-121), and the batch needs at least one line.
    expect(
      (
        await post({
          buyerCounterpartyId,
          callNote: 'note',
          lines: [{ ...line(skuOne, 1), ratePaise: 100 }],
        })
      ).status,
    ).toBe(400);
    expect((await post({ buyerCounterpartyId, callNote: 'note', lines: [] })).status).toBe(400);
  });

  it('desk boundary — Purchase cannot log a buyer call', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyIdOfBuyer(buyerId);
    const skuId = await createTestSku('Medium');

    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        buyerCounterpartyId,
        skuId,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'note',
      });
    expect(res.status).toBe(403);
  });
});

describe('Seller-side proxy actions (Purchase desk)', () => {
  it('"log a seller call" produces an identical record to a real listing — same shelf-life floor, call note on the line', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await createApprovedSeller(app, purchase.token);
    const sellerCounterpartyId = await counterpartyIdOfSeller(sellerId);
    const skuId = await createTestSku('Medium');
    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);
    const productId = (sku!.productId as unknown as string).toString();

    const res = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        sellerCounterpartyId,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 40000,
            expiryBand: 'over12',
            deliveryBand: '48h',
            provenance: 'company',
            qty: 100,
          },
        ],
        callNote: 'Seller called offering 100 boxes at 400/unit.',
      });
    expect(res.status).toBe(201);
    const { lineIds } = res.body.data as { lineIds: string[] };

    const line = await ListingLine.findById(lineIds[0]);
    expect(line!.proxyLog).toHaveLength(1);
    expect(line!.proxyLog![0]!.action).toBe('create_listing');
    expect(line!.proxyLog![0]!.callNote).toContain('100 boxes');

    // BR-107 — the shelf-life floor refuses exactly as the real POST /listings refuses it.
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const shortExpiry = `${String(nextMonth.getMonth() + 1).padStart(2, '0')}/${nextMonth.getFullYear()}`;
    const floorRes = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        sellerCounterpartyId,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 40000,
            expiryBand: 'under12',
            expiryExact: shortExpiry,
            deliveryBand: '48h',
            provenance: 'company',
            qty: 100,
          },
        ],
        callNote: 'note',
      });
    expect(floorRes.status).toBe(422);
    expect(floorRes.body.error.code).toBe('SHELF_LIFE_FLOOR');
  });

  it('"raise quote" on an ask produces the same quote a seller would post — gap codes, hold, call note on the Quote', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyIdOfBuyer(buyerId);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const sellerCounterpartyId = await counterpartyIdOfSeller(sellerId);
    const skuId = await createTestSku('Medium');

    const askRes = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId,
        skuId,
        qty: 10,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'Buyer wants 10 boxes.',
      });
    const { askId } = askRes.body.data as { askId: string };

    const quoteBody = {
      sellerCounterpartyId,
      ratePaiseForIndore: 40000,
      qtyAvailable: 4,
      expiryBand: 'over12',
      expiryExact: '12/2099',
      deliveryBand: '48h',
      provenance: 'company',
      daysToIndore: 2,
    };

    // The call note is mandatory.
    const noNote = await request(app)
      .post(`/api/v1/staff/proxy/seller/asks/${askId}/quotes`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send(quoteBody);
    expect(noNote.status).toBe(400);

    const res = await request(app)
      .post(`/api/v1/staff/proxy/seller/asks/${askId}/quotes`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ ...quoteBody, callNote: 'Seller called, can send 4 boxes at 400.' });
    expect(res.status).toBe(201);
    const { quoteId } = res.body.data as { quoteId: string };

    const { Quote } = await import('../src/models/Quote.js');
    const quote = await Quote.findById(quoteId);
    expect(quote!.sellerId!.toString()).toBe(sellerId);
    expect(quote!.gapCodes).toContain('short_on_quantity'); // BR-273 — 4 < 10.
    expect(quote!.proxyLog).toHaveLength(1);
    expect(quote!.proxyLog![0]!.action).toBe('post_quote');
    expect(quote!.proxyLog![0]!.actingStaffId!.toString()).toBe(purchase.employeeId);

    const ask = await Ask.findById(askId);
    expect(ask!.state).toBe('quoted');
    expect(ask!.holdExpiresAt).toBeTruthy(); // BR-126

    // BR-105 — "My stock" without a batch is refused exactly as on the seller's own screen.
    const noBatch = await request(app)
      .post(`/api/v1/staff/proxy/seller/asks/${askId}/quotes`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({ ...quoteBody, provenance: 'auth', callNote: 'note' });
    expect(noBatch.status).toBe(422);
    expect(noBatch.body.error.code).toBe('BATCH_REQUIRED');

    // Sales cannot raise it.
    const salesRes = await request(app)
      .post(`/api/v1/staff/proxy/seller/asks/${askId}/quotes`)
      .set('Authorization', `Bearer ${sales.token}`)
      .send({ ...quoteBody, callNote: 'note' });
    expect(salesRes.status).toBe(403);
  });

  it('desk boundary — Sales cannot log a seller call', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const sellerId = await createApprovedSeller(app, purchase.token);
    const sellerCounterpartyId = await counterpartyIdOfSeller(sellerId);
    const skuId = await createTestSku('Medium');
    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);
    const productId = (sku!.productId as unknown as string).toString();

    const res = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        sellerCounterpartyId,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 40000,
            expiryBand: 'over12',
            deliveryBand: '48h',
            provenance: 'company',
            qty: 100,
          },
        ],
        callNote: 'note',
      });
    expect(res.status).toBe(403);
  });
});

describe('Wall sweep, extended — a proxy response matches its counterparty-initiated equivalent', () => {
  it('a Sales staff member proxying for a buyer receives no seller identity anywhere in the response', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const buyerCounterpartyId = await counterpartyIdOfBuyer(buyerId);
    const skuId = await createTestSku('Medium');

    const world = {
      identities: {
        buyer: await identityOf('buyer', buyerId),
        seller: await identityOf('seller', sellerId),
      },
      soTotalPaise: 0,
    };

    const res = await request(app)
      .post('/api/v1/staff/proxy/buyer/asks')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        buyerCounterpartyId,
        skuId,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'note',
      });
    expect(res.status).toBe(201);

    const violations = findWallViolations('sales', res.body, world);
    expect(violations).toEqual([]);
  });

  it('a Purchase staff member proxying for a seller receives no buyer identity anywhere in the response', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const sellerCounterpartyId = await counterpartyIdOfSeller(sellerId);
    const skuId = await createTestSku('Medium');
    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);
    const productId = (sku!.productId as unknown as string).toString();

    const world = {
      identities: {
        buyer: await identityOf('buyer', buyerId),
        seller: await identityOf('seller', sellerId),
      },
      soTotalPaise: 0,
    };

    const res = await request(app)
      .post('/api/v1/staff/proxy/seller/listings')
      .set('Authorization', `Bearer ${purchase.token}`)
      .send({
        sellerCounterpartyId,
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 40000,
            expiryBand: 'over12',
            deliveryBand: '48h',
            provenance: 'company',
            qty: 100,
          },
        ],
        callNote: 'note',
      });
    expect(res.status).toBe(201);

    const violations = findWallViolations('purchase', res.body, world);
    expect(violations).toEqual([]);
  });
});

describe("Accounts' fourth gate genuinely blocks payment (client decision B)", () => {
  it('a PO stays not-payable after the dock inspection passes, until Accounts records its own confirmation', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const accounts = await staffToken(app, 'accounts');
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
    expect(soRes.status).toBe(201);
    const { soId } = soRes.body.data as { soId: string };
    const { So } = await import('../src/models/So.js');
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

    const inspectRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections`)
      .set('Authorization', `Bearer ${logistics.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ casesAccepted: 10, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
    expect(inspectRes.status).toBe(201);

    const applyRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(applyRes.status).toBe(200);

    // The dock's own inspection has already passed — but Accounts' fourth
    // gate has not run yet, so the PO must not be payable.
    expect(await paymentService.isPoPayable(poId)).toBe(false);
    const payableRes = await request(app)
      .get(`/api/v1/staff/payables/${poId}`)
      .set('Authorization', `Bearer ${accounts.token}`);
    expect(payableRes.body.data.payable).toBe(false);

    const buildBeforeConfirm = await request(app)
      .post('/api/v1/staff/payment-runs')
      .set('Authorization', `Bearer ${accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ items: [{ kind: 'payout', refId: poId }] });
    expect(buildBeforeConfirm.status).toBe(409);
    expect(buildBeforeConfirm.body.error.code).toBe('CHAIN_STAGE_GUARD_FAILED');

    // Accounts' own dedicated confirmation — its own recorded step.
    const confirmRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/receipt-confirmation`)
      .set('Authorization', `Bearer ${accounts.token}`)
      .send({ productMatches: true, qtyMatches: true });
    expect(confirmRes.status).toBe(201);

    expect(await paymentService.isPoPayable(poId)).toBe(true);
    const buildAfterConfirm = await request(app)
      .post('/api/v1/staff/payment-runs')
      .set('Authorization', `Bearer ${accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ items: [{ kind: 'payout', refId: poId }] });
    expect(buildAfterConfirm.status).toBe(201);
  });

  it('a confirmation that itself records a mismatch does not satisfy the gate', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const accounts = await staffToken(app, 'accounts');
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
    const { So } = await import('../src/models/So.js');
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
      .send({ casesAccepted: 10, casesRejected: 0, reasons: [], photoRefs: ['photo-1'] });
    await request(app)
      .post(`/api/v1/staff/pos/${poId}/inspections/apply`)
      .set('Authorization', `Bearer ${purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});

    const confirmRes = await request(app)
      .post(`/api/v1/staff/pos/${poId}/receipt-confirmation`)
      .set('Authorization', `Bearer ${accounts.token}`)
      .send({ productMatches: true, qtyMatches: false, notes: 'Quantity short by one case.' });
    expect(confirmRes.status).toBe(201);

    expect(await paymentService.isPoPayable(poId)).toBe(false);
  });
});
