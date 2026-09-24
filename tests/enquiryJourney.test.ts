import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { BuyerLocation } from '../src/models/BuyerLocation.js';
import { Chain } from '../src/models/Chain.js';
import { Enquiry } from '../src/models/Enquiry.js';
import { So } from '../src/models/So.js';
import { Sku } from '../src/models/Sku.js';
import { signAccessToken } from '../src/shared/tokens.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { backfillEnquiries } from '../src/modules/enquiry/enquiry.backfill.js';
import {
  deriveAskStatus,
  derivePileRequestStatus,
  tradeStatusOf,
} from '../src/modules/enquiry/enquiry.status.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';
import {
  findWallViolations,
  type Audience,
  type Identity,
  type WallWorld,
} from './wallSweepRules.js';

const app = createApp();

function idemKey(): string {
  return `enq-${Date.now()}-${Math.random()}`;
}

async function counterpartyOf(kind: 'buyer' | 'seller', docId: string): Promise<string> {
  const doc = kind === 'buyer' ? await Buyer.findById(docId) : await Seller.findById(docId);
  return doc!.counterpartyId!.toString();
}

async function identityOf(kind: 'buyer' | 'seller', docId: string): Promise<Identity> {
  const cpId = await counterpartyOf(kind, docId);
  const cp = await Counterparty.findById(cpId);
  return {
    ids: [docId, cpId],
    strings: [cp!.firm, cp!.gstin, cp!.mobile].filter((s): s is string => !!s),
  };
}

async function get(token: string, path: string) {
  return request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
}

async function post(token: string, path: string, body: unknown, idempotent = false) {
  const req = request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  if (idempotent) req.set('Idempotency-Key', idemKey());
  return req.send(body as object);
}

function expectNoWallViolations(audience: Audience, body: unknown, world: WallWorld): void {
  expect(findWallViolations(audience, body, world)).toEqual([]);
}

async function storedStatusOf(enquiryId: string): Promise<string> {
  return (await Enquiry.findById(enquiryId))!.status;
}

describe('Enquiry status — decided in one place, stored only up to the order', () => {
  const later = new Date(Date.now() + 60 * 60 * 1000);
  const earlier = new Date(Date.now() - 60 * 60 * 1000);

  it('an open ask inside the head start reads head_start; after it, awaiting_quotes', () => {
    expect(deriveAskStatus({ state: 'open', visibleToAllAt: later }).status).toBe('head_start');
    expect(deriveAskStatus({ state: 'open', visibleToAllAt: earlier }).status).toBe(
      'awaiting_quotes',
    );
  });

  it('a converted ask and a fanned-out pile both store `ordered`, and stop there', () => {
    expect(deriveAskStatus({ state: 'converted', visibleToAllAt: earlier })).toMatchObject({
      status: 'ordered',
      outcome: 'won',
    });
    expect(
      derivePileRequestStatus({ decision: 'confirmed', executedAt: new Date(), shortfall: false })
        .status,
    ).toBe('ordered');
  });

  it('a pile request reads the pile decision: undecided, undo window, shortfall, declined', () => {
    const base = { executedAt: null, shortfall: false };
    expect(derivePileRequestStatus({ ...base, decision: null }).status).toBe('awaiting_seller');
    expect(derivePileRequestStatus({ ...base, decision: 'confirmed' }).status).toBe('confirming');
    expect(
      derivePileRequestStatus({ decision: 'confirmed', executedAt: new Date(), shortfall: true })
        .waitingOn,
    ).toBe('desk');
    expect(derivePileRequestStatus({ ...base, decision: 'declined' }).outcome).toBe('lost');
  });

  it('after the order, the trade status is read from the orders themselves', () => {
    expect(tradeStatusOf([])).toBeNull();
    expect(tradeStatusOf(['awaiting_payment'])).toEqual({
      tradeStatus: 'in_trade',
      tradeWaitingOn: 'buyer',
    });
    expect(tradeStatusOf(['closed', 'cancelled'])!.tradeStatus).toBe('completed');
    expect(tradeStatusOf(['cancelled', 'supply_failed'])!.tradeStatus).toBe('cancelled');
  });
});

describe('Enquiry journey — a Sales call, through quotes, to a linked chain', () => {
  it('the stored status follows every step, and each desk sees its own side', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const logistics = await staffToken(app, 'transport_logistics');
    const accounts = await staffToken(app, 'accounts');

    const buyerId = await createApprovedBuyer(app, sales.token);
    const sellerId = await createApprovedSeller(app, purchase.token);
    const buyerCounterpartyId = await counterpartyOf('buyer', buyerId);
    const sellerCounterpartyId = await counterpartyOf('seller', sellerId);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);

    const world: WallWorld = {
      identities: {
        buyer: await identityOf('buyer', buyerId),
        seller: await identityOf('seller', sellerId),
      },
      soTotalPaise: -1,
    };

    // Raised — a registered buyer asking for a catalogue pack is an ask.
    const createRes = await post(sales.token, '/staff/enquiries', {
      buyerCounterpartyId,
      skuId,
      qty: 5,
      conditionRequirement: { expiryBand: 'over12' },
      callNote: 'Buyer called for 5 boxes.',
    });
    expect(createRes.status).toBe(201);
    const { enquiryId, enquiryNo, askId } = createRes.body.data as {
      enquiryId: string;
      enquiryNo: string;
      askId: string;
    };
    expect(enquiryNo).toMatch(/^ENQ-\d{2}-\d{5}$/);
    const stored = await Enquiry.findById(enquiryId);
    expect(stored).toMatchObject({ kind: 'ask', channel: 'sales_call' });
    expect(String(stored!.raisedBy)).toBe(sales.employeeId);
    expect(String((await Ask.findById(askId))!.enquiryId)).toBe(enquiryId);
    expect(['head_start', 'awaiting_quotes']).toContain(stored!.status);

    const salesList = await get(sales.token, `/staff/enquiries?q=${enquiryNo}`);
    expect(salesList.body.data).toHaveLength(1);
    expect(salesList.body.data[0]).toMatchObject({ id: enquiryId, phase: 'raised', quoteCount: 0 });
    expect(salesList.body.data[0].buyer.counterpartyId).toBe(buyerCounterpartyId);

    // Responded — a seller quotes; the enquiry moves in the same transaction.
    await demandService.postQuote(sellerCounterpartyId, askId, {
      ratePaiseForIndore: 40000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '06/2028',
      deliveryBand: '48h',
      provenance: 'company',
      daysToIndore: 2,
    });
    expect(await storedStatusOf(enquiryId)).toBe('quotes_received');

    const salesDetail = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(salesDetail.status).toBe(200);
    const s = salesDetail.body.data;
    expect(s.actions).toEqual(expect.arrayContaining(['accept_fill', 'walk_away', 'manage']));
    expect(typeof s.quotes[0].buyerRatePaise).toBe('number');
    expect(s.quotes[0].buyerRatePaise).not.toBe(40000);
    expect(s.timeline.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining([
        'enquiry_raised:sales_call',
        'ask_raised',
        'quote_received',
        'staff_call:raise_ask',
      ]),
    );
    expectNoWallViolations('sales', salesDetail.body, world);

    const purchaseDetail = await get(purchase.token, `/staff/enquiries/${enquiryId}`);
    expect(purchaseDetail.body.data.quotes[0].seller.counterpartyId).toBe(sellerCounterpartyId);
    expect(purchaseDetail.body.data.quotes[0].ratePaiseForIndore).toBe(40000);
    expect(purchaseDetail.body.data.actions).toEqual(['manage']);
    expectNoWallViolations('purchase', purchaseDetail.body, world);
    expect(JSON.stringify(purchaseDetail.body)).not.toContain('Buyer called');

    // Ordered — Sales accepts on a call, through the existing proxy endpoint.
    const acceptRes = await post(
      sales.token,
      `/staff/proxy/buyer/asks/${askId}/accept`,
      { buyerCounterpartyId, option: 'full', quoteIds: [s.quotes[0].quoteId], callNote: 'Yes.' },
      true,
    );
    expect(acceptRes.status).toBe(201);
    expect(await storedStatusOf(enquiryId)).toBe('ordered');
    const so = await So.findOne({ askId });
    expect(String(so!.enquiryId)).toBe(enquiryId);
    world.soTotalPaise = so!.totalPaise;

    const afterSales = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(afterSales.body.data).toMatchObject({
      status: 'ordered',
      outcome: 'won',
      tradeStatus: 'in_trade',
      tradeWaitingOn: 'buyer',
      orderCount: 1,
    });
    expect(afterSales.body.data.chains[0].view.stage).toBe('so');
    expectNoWallViolations('sales', afterSales.body, world);

    // Walking away from an ordered ask is refused, and leaves the enquiry ordered.
    const walkAway = await post(sales.token, `/staff/proxy/buyer/asks/${askId}/decline`, {
      buyerCounterpartyId,
      callNote: 'Changed his mind.',
    });
    expect(walkAway.status).toBe(409);
    expect(walkAway.body.error.code).toBe('ENQUIRY_NOT_OPEN');
    expect(await storedStatusOf(enquiryId)).toBe('ordered');

    expectNoWallViolations(
      'purchase',
      (await get(purchase.token, `/staff/enquiries/${enquiryId}`)).body,
      world,
    );
    const logisticsDetail = await get(logistics.token, `/staff/enquiries/${enquiryId}`);
    expect(logisticsDetail.status).toBe(200);
    expectNoWallViolations('logistics', logisticsDetail.body, world);
    expectNoWallViolations(
      'logistics',
      (await get(logistics.token, '/staff/enquiries')).body,
      world,
    );

    const full = await get(accounts.token, `/staff/enquiries/${enquiryId}`);
    expect(full.body.data.buyer.counterpartyId).toBe(buyerCounterpartyId);
    expect(full.body.data.quotes[0].seller.counterpartyId).toBe(sellerCounterpartyId);
  }, 30000);
});

describe('Enquiry journey — a listed rate taken, confirmed on a Purchase call, fanned out', () => {
  it('opens an enquiry per buyer, and one pile decision moves it', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const logistics = await staffToken(app, 'transport_logistics');

    const tehsil = await createTehsil();
    const sellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const sellerCounterpartyId = await counterpartyOf('seller', sellerId);
    const buyerCounterpartyId = await counterpartyOf('buyer', buyerId);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);
    const productId = (await Sku.findById(skuId))!.productId!.toString();

    const world: WallWorld = {
      identities: {
        buyer: await identityOf('buyer', buyerId),
        seller: await identityOf('seller', sellerId),
      },
      soTotalPaise: -1,
    };
    const tokenOf = (counterpartyId: string) =>
      signAccessToken({
        sub: counterpartyId,
        actorType: 'counterparty',
        counterpartyId,
        roles: [],
        permissions: [],
        status: 'active',
      });

    const listingRes = await request(app)
      .post('/api/v1/listings')
      .set('Authorization', `Bearer ${await tokenOf(sellerCounterpartyId)}`)
      .send({
        productId,
        scopeType: 'my_area',
        lines: [
          {
            skuId,
            ratePaise: 40000,
            expiryBand: 'over12',
            moqExact: 1,
            deliveryBand: '48h',
            provenance: 'company',
            qty: 100,
          },
        ],
      });
    expect(listingRes.status).toBe(201);
    const lineId = (listingRes.body.data as { lineIds: string[] }).lineIds[0]!;

    const location = await BuyerLocation.create({
      buyerId,
      label: 'Warehouse',
      address: 'Test address',
      pin: '452001',
      licenceNo: 'LIC-X',
      approvedBy: sales.employeeId,
      approvedAt: new Date(),
      isPrimary: true,
    });
    const inquireRes = await request(app)
      .post(`/api/v1/listings/lines/${lineId}/inquire`)
      .set('Authorization', `Bearer ${await tokenOf(buyerCounterpartyId)}`)
      .set('Idempotency-Key', idemKey())
      .send({ qty: 10, deliveryLocationId: String(location._id) });
    expect(inquireRes.status).toBe(201);
    const { pileId, enquiryId } = inquireRes.body.data as { pileId: string; enquiryId: string };
    const enquiry = await Enquiry.findById(enquiryId);
    expect(enquiry).toMatchObject({
      kind: 'pile_request',
      channel: 'self',
      status: 'awaiting_seller',
    });

    const purchaseList = await get(purchase.token, `/staff/enquiries?q=${enquiry!.enquiryNo}`);
    expect(purchaseList.body.data[0].seller.counterpartyId).toBe(sellerCounterpartyId);
    expectNoWallViolations('purchase', purchaseList.body, world);

    const before = await get(purchase.token, `/staff/enquiries/${enquiryId}`);
    expect(before.body.data.actions).toEqual([
      'confirm_pile',
      'requote_pile',
      'decline_pile',
      'manage',
    ]);

    const confirmRes = await post(
      purchase.token,
      `/staff/proxy/seller/confirmations/${pileId}/confirm`,
      {
        sellerCounterpartyId,
        canSendBoxes: 10,
        expiryExact: '06/2028',
        callNote: 'Seller confirmed on the phone.',
      },
      true,
    );
    expect(confirmRes.status).toBe(201);
    expect(await storedStatusOf(enquiryId)).toBe('confirming');

    await demandService.runConfirmPileFanout(pileId);
    expect(await storedStatusOf(enquiryId)).toBe('ordered');

    const so = await So.findOne({ enquiryId });
    expect(String(so!.pileRequestId)).toBe(String(enquiry!.pileRequestId));
    expect((await Chain.findById(so!.chainId))!.source).toBe('listed');
    world.soTotalPaise = so!.totalPaise;

    const afterPurchase = await get(purchase.token, `/staff/enquiries/${enquiryId}`);
    expect(afterPurchase.body.data).toMatchObject({ tradeStatus: 'in_trade', orderCount: 1 });
    expect(afterPurchase.body.data.line.ratePaise).toBe(40000);
    expectNoWallViolations('purchase', afterPurchase.body, world);

    const afterSales = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(afterSales.body.data.buyer.counterpartyId).toBe(buyerCounterpartyId);
    expect(typeof afterSales.body.data.line.buyerRatePaise).toBe('number');
    expect(JSON.stringify(afterSales.body)).not.toContain('Seller confirmed on the phone');
    expectNoWallViolations('sales', afterSales.body, world);

    expectNoWallViolations(
      'logistics',
      (await get(logistics.token, `/staff/enquiries/${enquiryId}`)).body,
      world,
    );
  }, 30000);
});

describe('Pre-trade enquiries (DEC-052)', () => {
  it('a prospect asking for an unlisted product is logged, walled from Purchase, and converts to an ask', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const logistics = await staffToken(app, 'transport_logistics');
    const prospectFirm = `Prospect Agro ${Date.now()}`;

    const createRes = await post(sales.token, '/staff/enquiries', {
      prospect: { firm: prospectFirm, contactName: 'Ramesh', mobile: '9876543210', place: 'Dewas' },
      productText: 'Some new herbicide, 1L',
      qty: 12,
      callNote: 'Walk-in enquiry, not registered yet.',
    });
    expect(createRes.status).toBe(201);
    const { enquiryId, enquiryNo } = createRes.body.data as {
      enquiryId: string;
      enquiryNo: string;
    };
    expect(await Enquiry.findById(enquiryId)).toMatchObject({
      kind: 'pre_trade',
      status: 'pre_trade',
      waitingOn: 'desk',
      productText: 'Some new herbicide, 1L',
    });

    const salesDetail = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(salesDetail.body.data.prospect.firm).toBe(prospectFirm);
    expect(salesDetail.body.data.actions).toEqual(
      expect.arrayContaining(['convert_to_ask', 'drop', 'manage']),
    );
    expect(salesDetail.body.data.notes[0].text).toContain('Walk-in');

    // The prospect is buyer-side identity: never on Purchase's or Logistics's screen.
    for (const token of [purchase.token, logistics.token]) {
      const text = JSON.stringify((await get(token, `/staff/enquiries/${enquiryId}`)).body);
      expect(text).not.toContain(prospectFirm);
      expect(text).not.toContain('9876543210');
      expect(text).not.toContain('Walk-in');
    }

    // He registers; the product is added — Sales converts the SAME enquiry to an ask.
    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyOf('buyer', buyerId);
    const skuId = await createTestSku('B');
    const convertRes = await post(sales.token, `/staff/enquiries/${enquiryId}/convert`, {
      buyerCounterpartyId,
      skuId,
      conditionRequirement: { expiryBand: 'over12' },
      callNote: 'Registered now, confirmed the pack.',
    });
    expect(convertRes.status).toBe(201);
    const converted = await Enquiry.findById(enquiryId);
    expect(converted).toMatchObject({ kind: 'ask', enquiryNo, qty: 12 });
    expect(['head_start', 'awaiting_quotes']).toContain(converted!.status);
    const ask = await Ask.findById(convertRes.body.data.askId);
    expect(String(ask!.enquiryId)).toBe(enquiryId);
    expect(ask!.proxyLog![0]!.action).toBe('convert_enquiry');

    const again = await post(sales.token, `/staff/enquiries/${enquiryId}/convert`, {
      buyerCounterpartyId,
      skuId,
      conditionRequirement: { expiryBand: 'over12' },
      callNote: 'Twice.',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ENQUIRY_NOT_OPEN');
  }, 30000);

  it('a pre-trade enquiry is dropped with a fixed reason, once', async () => {
    const sales = await staffToken(app, 'sales');
    const { enquiryId } = (
      await post(sales.token, '/staff/enquiries', {
        prospect: { firm: 'Never Registered Co' },
        productText: 'Anything',
        qty: 1,
        callNote: 'Asked about prices.',
      })
    ).body.data as { enquiryId: string };

    const dropRes = await post(sales.token, `/staff/enquiries/${enquiryId}/drop`, {
      reason: 'buyer_not_registrable',
      callNote: 'No GSTIN.',
    });
    expect(dropRes.status).toBe(200);
    expect(await Enquiry.findById(enquiryId)).toMatchObject({
      status: 'dropped',
      outcome: 'lost',
      dropReason: 'buyer_not_registrable',
    });
    const again = await post(sales.token, `/staff/enquiries/${enquiryId}/drop`, {
      reason: 'other',
      callNote: 'Again.',
    });
    expect(again.status).toBe(409);
  });

  it('edits the still-draft fields of a pre-trade enquiry, refuses once ordered, and refuses a prospect field on a buyer enquiry', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const { enquiryId } = (
      await post(sales.token, '/staff/enquiries', {
        prospect: { firm: 'Edit Me Co', place: 'Dewas' },
        productText: 'Old product text',
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'First call.',
      })
    ).body.data as { enquiryId: string };

    const editRes = await post(sales.token, `/staff/enquiries/${enquiryId}/edit`, {
      qty: 8,
      conditionRequirement: { expiryBand: 'under12', deliveryBand: '48h' },
      prospect: { firm: 'Edit Me Co', place: 'Indore' },
      productText: 'New product text',
      callNote: 'Buyer called back, changed his mind on quantity and place.',
    });
    expect(editRes.status).toBe(200);
    const edited = await Enquiry.findById(enquiryId);
    expect(edited).toMatchObject({
      qty: 8,
      productText: 'New product text',
      status: 'pre_trade', // Editing never moves the status.
    });
    expect(edited!.requirement).toMatchObject({ expiryBand: 'under12', deliveryBand: '48h' });
    expect(edited!.prospect).toMatchObject({ firm: 'Edit Me Co', place: 'Indore' });
    expect(edited!.notes!.at(-1)!.text).toContain('changed his mind');

    const buyerId = await createApprovedBuyer(app, sales.token);
    const buyerCounterpartyId = await counterpartyOf('buyer', buyerId);
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);
    const catalogueEnquiry = (
      await post(sales.token, '/staff/enquiries', {
        buyerCounterpartyId,
        skuId,
        qty: 3,
        conditionRequirement: { expiryBand: 'over12' },
        callNote: 'Registered buyer, real pack — this is already an ask.',
      })
    ).body.data as { enquiryId: string };

    // Editing an ordered/ask enquiry is refused outright.
    const editAsk = await post(sales.token, `/staff/enquiries/${catalogueEnquiry.enquiryId}/edit`, {
      qty: 9,
      callNote: 'Trying anyway.',
    });
    expect(editAsk.status).toBe(409);
    expect(editAsk.body.error.code).toBe('ENQUIRY_NOT_OPEN');

    // A prospect field on an enquiry that has a registered buyer, not a prospect.
    const anotherPreTrade = (
      await post(sales.token, '/staff/enquiries', {
        buyerCounterpartyId,
        productText: 'Not in catalogue',
        qty: 1,
        callNote: 'Registered buyer wants something we do not stock.',
      })
    ).body.data as { enquiryId: string };
    const wrongField = await post(
      sales.token,
      `/staff/enquiries/${anotherPreTrade.enquiryId}/edit`,
      {
        prospect: { firm: 'Should not apply' },
        callNote: 'x',
      },
    );
    expect(wrongField.status).toBe(400);
  }, 30000);

  it('refuses both a buyer and a prospect, neither, a price field, and Purchase creating one', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const base = { productText: 'x', qty: 1, callNote: 'n' };
    expect((await post(sales.token, '/staff/enquiries', base)).status).toBe(400);
    expect(
      (
        await post(sales.token, '/staff/enquiries', {
          ...base,
          prospect: { firm: 'A' },
          buyerCounterpartyId: '000000000000000000000000',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(sales.token, '/staff/enquiries', {
          ...base,
          prospect: { firm: 'A' },
          ratePaise: 100,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(purchase.token, '/staff/enquiries', { ...base, prospect: { firm: 'A' } })).status,
    ).toBe(403);
  });
});

describe('Seller enquiries (DEC-052) — the Purchase-side mirror of pre-trade', () => {
  it('logs a registered seller, is walled from Sales, and marks listed', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const sellerId = await createApprovedSeller(app, purchase.token);
    const sellerCounterpartyId = await counterpartyOf('seller', sellerId);
    const skuId = await createTestSku('B');

    const createRes = await post(purchase.token, '/staff/enquiries', {
      party: 'seller',
      sellerCounterpartyId,
      skuId,
      qty: 50,
      callNote: 'Seller called offering 50 boxes.',
    });
    expect(createRes.status).toBe(201);
    const { enquiryId } = createRes.body.data as { enquiryId: string; enquiryNo: string };
    const stored = await Enquiry.findById(enquiryId);
    expect(stored).toMatchObject({
      kind: 'pre_trade',
      party: 'seller',
      status: 'pre_trade',
      channel: 'sales_call',
    });
    expect(String(stored!.sellerId)).toBe(sellerId);
    expect(stored!.buyerId).toBeNull();
    expect(stored!.notes![0]).toMatchObject({ desk: 'purchase' });

    // Purchase sees the seller; Sales sees neither seller nor buyer (there is none).
    const purchaseDetail = await get(purchase.token, `/staff/enquiries/${enquiryId}`);
    expect(purchaseDetail.body.data.seller.counterpartyId).toBe(sellerCounterpartyId);
    expect(purchaseDetail.body.data.actions).toEqual(
      expect.arrayContaining(['mark_listed', 'drop', 'edit', 'manage']),
    );
    expect(purchaseDetail.body.data.actions).not.toContain('convert_to_ask');
    const salesDetail = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(salesDetail.body.data.seller).toBeUndefined();
    expect(salesDetail.body.data.buyer).toBeNull();
    expect(salesDetail.body.data.actions).not.toEqual(
      expect.arrayContaining(['mark_listed', 'drop', 'edit']),
    );

    // Sales cannot act on a seller-party enquiry, even holding buyer_call generally.
    const salesTriesEdit = await post(sales.token, `/staff/enquiries/${enquiryId}/edit`, {
      qty: 99,
      callNote: 'x',
    });
    expect(salesTriesEdit.status).toBe(403);

    // Converting is buyer-only.
    const tryConvert = await post(purchase.token, `/staff/enquiries/${enquiryId}/convert`, {
      buyerCounterpartyId: sellerCounterpartyId,
      skuId,
      conditionRequirement: { expiryBand: 'over12' },
      callNote: 'x',
    });
    expect(tryConvert.status).toBe(403); // Purchase never held proxy:buyer_call.

    // Purchase marks it listed once a real listing exists elsewhere.
    const listedRes = await post(purchase.token, `/staff/enquiries/${enquiryId}/mark-listed`, {
      callNote: 'Created the listing on the Purchase desk.',
    });
    expect(listedRes.status).toBe(200);
    expect(await Enquiry.findById(enquiryId)).toMatchObject({
      status: 'listed',
      outcome: 'won',
      phase: 'closed',
    });

    const again = await post(purchase.token, `/staff/enquiries/${enquiryId}/mark-listed`, {
      callNote: 'Again.',
    });
    expect(again.status).toBe(409);
  }, 30000);

  it('logs a seller prospect, hides the prospect from Sales, and drops it', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sales = await staffToken(app, 'sales');
    const prospectFirm = `Prospect Seller Co ${Date.now()}`;

    const createRes = await post(purchase.token, '/staff/enquiries', {
      party: 'seller',
      prospect: { firm: prospectFirm, place: 'Ujjain' },
      productText: 'Some pesticide, 500ml',
      qty: 20,
      callNote: 'Not registered yet, wants to supply.',
    });
    expect(createRes.status).toBe(201);
    const { enquiryId } = createRes.body.data as { enquiryId: string };

    const purchaseDetail = await get(purchase.token, `/staff/enquiries/${enquiryId}`);
    expect(purchaseDetail.body.data.prospect.firm).toBe(prospectFirm);

    // The seller-prospect is Purchase's own identity data — never Sales's.
    const salesText = JSON.stringify(
      (await get(sales.token, `/staff/enquiries/${enquiryId}`)).body,
    );
    expect(salesText).not.toContain(prospectFirm);

    const dropRes = await post(purchase.token, `/staff/enquiries/${enquiryId}/drop`, {
      reason: 'product_not_stocked',
      callNote: 'Not a fit.',
    });
    expect(dropRes.status).toBe(200);
    expect(await Enquiry.findById(enquiryId)).toMatchObject({ status: 'dropped' });
  });

  it('refuses a seller party without proxy:seller_call, even with proxy:buyer_call', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await post(sales.token, '/staff/enquiries', {
      party: 'seller',
      prospect: { firm: 'X' },
      productText: 'y',
      qty: 1,
      callNote: 'n',
    });
    expect(res.status).toBe(403);
  });
});

describe('Owner, follow-up and notes — each desk works its own half', () => {
  it('assigns, filters, and keeps notes on their own desk', async () => {
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const controller = await staffToken(app, 'controller');
    const logistics = await staffToken(app, 'transport_logistics');
    const { enquiryId } = (
      await post(sales.token, '/staff/enquiries', {
        prospect: { firm: 'Owner Test Co' },
        productText: 'x',
        qty: 3,
        callNote: 'First call.',
      })
    ).body.data as { enquiryId: string };

    // Sales takes its own half; cannot touch Purchase's; cannot hand it to a Purchase person.
    expect(
      (
        await post(sales.token, `/staff/enquiries/${enquiryId}/owner`, {
          employeeId: sales.employeeId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(sales.token, `/staff/enquiries/${enquiryId}/owner`, {
          desk: 'purchase',
          employeeId: sales.employeeId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(sales.token, `/staff/enquiries/${enquiryId}/owner`, {
          employeeId: purchase.employeeId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(purchase.token, `/staff/enquiries/${enquiryId}/owner`, {
          employeeId: purchase.employeeId,
        })
      ).status,
    ).toBe(200);
    const assignees = await get(sales.token, '/staff/enquiries/assignees?desk=sales');
    expect(assignees.body.data.map((a: { employeeId: string }) => a.employeeId)).toContain(
      sales.employeeId,
    );

    const mine = await get(sales.token, '/staff/enquiries?mine=true&limit=200');
    expect(mine.body.data.map((r: { id: string }) => r.id)).toContain(enquiryId);
    const detail = await get(sales.token, `/staff/enquiries/${enquiryId}`);
    expect(detail.body.data.owners.sales.employeeId).toBe(sales.employeeId);
    expect(detail.body.data.owners.purchase.employeeId).toBe(purchase.employeeId);

    // A follow-up due now shows on Sales's due list, not on Purchase's.
    const due = new Date(Date.now() - 60_000).toISOString();
    expect(
      (await post(sales.token, `/staff/enquiries/${enquiryId}/follow-up`, { at: due })).status,
    ).toBe(200);
    const salesDue = await get(sales.token, '/staff/enquiries?followUpDue=true&limit=200');
    expect(salesDue.body.data.map((r: { id: string }) => r.id)).toContain(enquiryId);
    const purchaseDue = await get(purchase.token, '/staff/enquiries?followUpDue=true&limit=200');
    expect(purchaseDue.body.data.map((r: { id: string }) => r.id)).not.toContain(enquiryId);

    // Notes stay on the desk that wrote them; the Controller reads both.
    await post(purchase.token, `/staff/enquiries/${enquiryId}/notes`, {
      text: 'Checked with two sellers, none stock it.',
    });
    const salesNotes = (await get(sales.token, `/staff/enquiries/${enquiryId}`)).body.data.notes;
    expect(salesNotes.map((n: { text: string }) => n.text)).not.toContain(
      'Checked with two sellers, none stock it.',
    );
    const controllerNotes = (await get(controller.token, `/staff/enquiries/${enquiryId}`)).body.data
      .notes;
    expect(controllerNotes).toHaveLength(2);

    // The Controller may set either half, but must say which.
    expect(
      (await post(controller.token, `/staff/enquiries/${enquiryId}/owner`, { employeeId: null }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(controller.token, `/staff/enquiries/${enquiryId}/owner`, {
          desk: 'sales',
          employeeId: null,
        })
      ).status,
    ).toBe(200);

    // Logistics has no half to work.
    expect(
      (await post(logistics.token, `/staff/enquiries/${enquiryId}/notes`, { text: 'x' })).status,
    ).toBe(403);
  }, 30000);
});

describe('Backfill — enquiries for asks raised before the record existed', () => {
  it('creates one enquiry per legacy ask, links its orders, and is idempotent', async () => {
    const sales = await staffToken(app, 'sales');
    const buyerId = await createApprovedBuyer(app, sales.token);
    const skuId = await createTestSku('B');
    const legacy = await Ask.create({
      buyerId,
      skuId,
      allPacks: false,
      qty: 4,
      conditionRequirement: { expiryBand: 'over12' },
      visibleToAllAt: new Date(Date.now() - 1000),
      headStartOpenedAt: new Date(),
      ttlAt: new Date(Date.now() + 86_400_000),
      state: 'quoted',
    });

    await backfillEnquiries();
    const enquiry = await Enquiry.findOne({ askId: legacy._id });
    expect(enquiry).toMatchObject({ kind: 'ask', channel: 'self', status: 'quotes_received' });
    expect(String((await Ask.findById(legacy._id))!.enquiryId)).toBe(String(enquiry!._id));

    await backfillEnquiries();
    expect(await Enquiry.countDocuments({ askId: legacy._id })).toBe(1);
  });
});

describe('Enquiry routes — the boundary', () => {
  it('404s an unknown enquiry, 400s a malformed id, 401s without a token', async () => {
    const sales = await staffToken(app, 'sales');
    expect((await get(sales.token, '/staff/enquiries/000000000000000000000000')).status).toBe(404);
    expect((await get(sales.token, '/staff/enquiries/not-an-id')).status).toBe(400);
    expect((await request(app).get('/api/v1/staff/enquiries')).status).toBe(401);
  });
});
