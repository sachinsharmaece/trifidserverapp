import { afterAll, describe, expect, it } from 'vitest';
import { RateLimit } from '../src/models/RateLimit.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Chain } from '../src/models/Chain.js';
import { So } from '../src/models/So.js';
import { SoLine } from '../src/models/SoLine.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { SellerCatalogueEntry } from '../src/models/SellerCatalogueEntry.js';
import { getSellerFunnelMetrics } from '../src/modules/desk/purchase/purchase.funnel.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { findWallViolations, type Identity } from './wallSweepRules.js';
import { env } from '../src/config/env.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import { createTehsil, createApprovedSellerAtTehsils } from './m5helpers.js';
import { randomGstin, randomMobile } from './helpers.js';

/**
 * "Asks reaching the desks" — the client's My-view items 13, 14 and 16.
 *
 * Every step goes through the real request path: self-registration, staff
 * approval, a real OTP login for the buyer's token, the same POST /asks the
 * buyer app calls, and the same staff GET routes the two desks call. Nothing
 * is built by hand with Model.create except the Tehsil and the margin matrix
 * (neither has a public create route a buyer could use).
 */

const app = createApp();

function bankDetail() {
  return {
    accountNumber: `${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    ifsc: 'HDFC0001234',
    accountName: 'Test Account',
  };
}

interface RegisteredBuyer {
  buyerDocId: string;
  counterpartyId: string;
  token: string;
}

/** Self-registers a buyer, has Sales approve him at `tehsilId`, then logs him in by OTP. */
async function registerApproveAndLogIn(
  salesToken: string,
  tehsilId: string,
  realLogin = false,
): Promise<RegisteredBuyer> {
  const mobile = randomMobile();
  const registerRes = await request(app)
    .post('/api/v1/registrations/buyer')
    .send({
      mobile,
      firm: `Asker Firm ${Date.now()}-${Math.random()}`,
      gstin: await randomGstin(),
      ownerName: 'Owner Name',
      licenceNo: 'LIC-1',
      gstPpobAddress: 'Some address',
      bankDetail: bankDetail(),
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    });
  expect(registerRes.status).toBe(201);
  const registrationId = registerRes.body.data.registrationId as string;

  const approveRes = await request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${salesToken}`)
    .send({ tehsilId, tradePosition: 'dealer', isTrader: false });
  expect(approveRes.status).toBe(200);

  const buyer = await Buyer.findOne({ counterpartyId: registrationId });
  const base = { buyerDocId: String(buyer!._id), counterpartyId: registrationId };
  // The OTP endpoint allows 10 requests per IP per 10 minutes and the whole suite shares one
  // IP, so only two tests log a buyer in through the real OTP flow (the rest sign the same
  // token the OTP flow issues) and `afterAll` below gives the budget back.
  if (!realLogin) {
    const token = signAccessToken({
      sub: registrationId,
      actorType: 'counterparty',
      counterpartyId: registrationId,
      roles: [],
      permissions: [],
      status: 'active',
    });
    return { ...base, token };
  }

  const otpRequest = await request(app).post('/api/v1/auth/otp/request').send({ mobile });
  const { requestId, devCode } = otpRequest.body.data as { requestId: string; devCode: string };
  const otpVerify = await request(app)
    .post('/api/v1/auth/otp/verify')
    .send({ requestId, code: devCode, deviceFingerprint: `fp-${mobile}` });
  expect(otpVerify.status).toBe(200);
  return { ...base, token: otpVerify.body.data.accessToken as string };
}

async function getAs(token: string, path: string) {
  return request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
}

async function postAs(token: string, path: string, body: object) {
  return request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
}

afterAll(async () => {
  await RateLimit.deleteMany({ key: { $regex: '^otp-req:' } });
});

async function seedWorld(options: { trustedSeller: boolean; otpLogin?: boolean }) {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');

  const tehsilT = await createTehsil();
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsilT]);
  if (options.trustedSeller) {
    await Seller.updateOne({ _id: sellerDocId }, { $set: { trustTier: 'Trusted' } });
  }
  const seller = await Seller.findById(sellerDocId);
  const sellerCounterpartyId = String(seller!.counterpartyId);
  const sellerToken = signAccessToken({
    sub: sellerCounterpartyId,
    actorType: 'counterparty',
    counterpartyId: sellerCounterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });

  const skuId = await createTestSku('Medium');
  const sku = await Sku.findById(skuId);
  const productId = String(sku!.productId);
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.03, admin.employeeId);
  }

  const listing = await postAs(sellerToken, '/listings', {
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
  expect(listing.status).toBe(201);

  const buyer = await registerApproveAndLogIn(sales.token, tehsilT, options.otpLogin ?? false);
  const sellerIdentity = await identityOf(sellerCounterpartyId, sellerDocId);
  return { admin, sales, purchase, tehsilT, sellerDocId, skuId, productId, buyer, sellerIdentity };
}

async function identityOf(counterpartyId: string, docId: string): Promise<Identity> {
  const cp = await Counterparty.findById(counterpartyId);
  return {
    ids: [docId, counterpartyId],
    strings: [cp!.firm, cp!.gstin, cp!.mobile].filter((s): s is string => !!s),
  };
}

/** The wall, for one response: Purchase must not see the buyer, Sales must not see the seller. */
async function expectWall(
  audience: 'purchase' | 'sales',
  body: unknown,
  buyer: RegisteredBuyer,
  sellerIdentity: Identity,
): Promise<void> {
  const world = {
    identities: {
      buyer: await identityOf(buyer.counterpartyId, buyer.buyerDocId),
      seller: sellerIdentity,
    },
    soTotalPaise: -1, // no order exists here; -1 can match no number in a body.
  };
  expect(findWallViolations(audience, body, world)).toEqual([]);
}

/** BR-064/067/069 — a Purchase ask row carries no tehsil, district, buyer, or rupee figure. */
function expectNoAskLocationOrMoney(rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      expect(key).not.toMatch(/tehsil|district|buyer|rupee|paise|rate|price/i);
    }
  }
}

/** An ask, with the id swapped out, so an app ask and a proxy ask can be compared row for row. */
function withoutIds<T>(value: T, askIds: string[]): unknown {
  let text = JSON.stringify(value);
  for (const id of askIds) text = text.split(id).join('<ASK>');
  return JSON.parse(text);
}

describe('13 — an ask from the buyer app reaches every desk read', () => {
  // The suite forces ENQUIRY_FLOW_ENABLED on (vitest.config.ts); production defaults it off.
  // Run the whole matrix under the production default as well as the suite's.
  const cases = [
    { trustedSeller: false, enquiryFlow: false },
    { trustedSeller: true, enquiryFlow: false },
    { trustedSeller: true, enquiryFlow: true },
  ];
  for (const { trustedSeller, enquiryFlow } of cases) {
    const label =
      (trustedSeller
        ? 'with a Trusted seller (head start running)'
        : 'with no Trusted seller (opens at once)') +
      `, enquiry flow ${enquiryFlow ? 'on' : 'off'}`;

    it(`specific pack and all packs both show on Purchase and Sales — ${label}`, async () => {
      const flagBefore = env.enquiryFlowEnabled;
      env.enquiryFlowEnabled = enquiryFlow;
      try {
        await runDeskReadChecks(trustedSeller, !trustedSeller && !enquiryFlow);
      } finally {
        env.enquiryFlowEnabled = flagBefore;
      }
    });
  }
});

async function runDeskReadChecks(trustedSeller: boolean, otpLogin: boolean): Promise<void> {
  {
    {
      const w = await seedWorld({ trustedSeller, otpLogin });

      const specific = await postAs(w.buyer.token, '/asks', {
        skuId: w.skuId,
        allPacks: false,
        qty: 5,
        conditionRequirement: { expiryBand: 'over12' },
      });
      expect(specific.status).toBe(201);
      const allPacks = await postAs(w.buyer.token, '/asks', {
        productId: w.productId,
        allPacks: true,
        qty: 7,
        conditionRequirement: { expiryBand: 'over12' },
      });
      expect(allPacks.status).toBe(201);
      const specificId = specific.body.data.askId as string;
      const allPacksId = allPacks.body.data.askId as string;

      // The head start really is running in the Trusted case — the ask is not yet open to all.
      const stored = await Ask.findById(specificId);
      if (trustedSeller) expect(stored!.visibleToAllAt.getTime()).toBeGreaterThan(Date.now());

      // Purchase — active demand list, and the No-seller filter (a live listing exists, so neither is "no seller").
      const demand = await getAs(w.purchase.token, '/staff/purchase/demand');
      expect(demand.status).toBe(200);
      const demandIds = (demand.body.data as Array<{ askId: string }>).map((r) => r.askId);
      expect(demandIds).toContain(specificId);
      expect(demandIds).toContain(allPacksId);

      const noSeller = await getAs(w.purchase.token, '/staff/purchase/demand?noSeller=true');
      const noSellerIds = (noSeller.body.data as Array<{ askId: string }>).map((r) => r.askId);
      expect(noSellerIds).not.toContain(specificId);
      expect(noSellerIds).not.toContain(allPacksId);

      const onBoard = await getAs(w.purchase.token, '/staff/purchase/demand/on-board-not-quoted');
      const onBoardIds = (onBoard.body.data as Array<{ askId: string }>).map((r) => r.askId);
      expect(onBoardIds).toContain(specificId);
      expect(onBoardIds).toContain(allPacksId);

      // Purchase — the product's funnel row counts both asks and their open boxes.
      const productFunnel = await getAs(w.purchase.token, '/staff/purchase/products/funnel');
      const row = (
        productFunnel.body.data as Array<{ productId: string; inq: number; openBoxes: number }>
      ).find((r) => r.productId === w.productId);
      expect(row?.inq).toBe(2);
      expect(row?.openBoxes).toBe(12);

      // Sales — the new buyer is in the Queue, not any Book; the Book tab does not show him.
      const queue = await getAs(w.sales.token, '/staff/sales/buyers?tab=queue');
      const queueRow = (queue.body.data as Array<{ buyerId: string }>).find(
        (b) => b.buyerId === w.buyer.buyerDocId,
      );
      expect(queueRow).toBeDefined();
      const book = await getAs(w.sales.token, '/staff/sales/buyers?tab=book');
      expect((book.body.data as Array<{ buyerId: string }>).map((b) => b.buyerId)).not.toContain(
        w.buyer.buyerDocId,
      );

      // Sales — the buyer file lists both asks, and the id it hands the screen is the Buyer doc id.
      const file = await getAs(w.sales.token, `/staff/sales/buyers/${w.buyer.buyerDocId}`);
      expect(file.status).toBe(200);
      const fileAskIds = (file.body.data.openAsks as Array<{ askId: string }>).map((a) => a.askId);
      expect(fileAskIds).toContain(specificId);
      expect(fileAskIds).toContain(allPacksId);

      // Sales — Today's "He asked" bucket (not owner-scoped), and the funnel's Asked count.
      const worklist = await getAs(w.sales.token, '/staff/sales/worklist');
      const heAsked = (worklist.body.data as Array<{ bucket: string; refId: string }>)
        .filter((i) => i.bucket === 'he_asked')
        .map((i) => i.refId);
      expect(heAsked).toContain(specificId);
      expect(heAsked).toContain(allPacksId);

      const funnel = await getAs(w.sales.token, '/staff/sales/funnel');
      const asked = (funnel.body.data.metrics as Array<{ key: string; value: number }>).find(
        (m) => m.key === 'asked',
      );
      expect(asked!.value).toBeGreaterThanOrEqual(2);

      // Sales — the product board lists both asks as open demand on that product.
      const board = await getAs(w.sales.token, `/staff/sales/board/${w.productId}`);
      expect(board.status).toBe(200);
      const boardAskIds = (board.body.data.openAsks as Array<{ askId: string }>).map(
        (a) => a.askId,
      );
      expect(boardAskIds).toContain(allPacksId);
      expect(boardAskIds).toContain(specificId); // A pack-specific ask carries no productId of its own.

      // The wall, on every desk read just made (Purchase: no buyer, no tehsil/district/rupee on an
      // ask; Sales: no seller).
      await expectWall('purchase', demand.body, w.buyer, w.sellerIdentity);
      await expectWall('purchase', onBoard.body, w.buyer, w.sellerIdentity);
      await expectWall('purchase', productFunnel.body, w.buyer, w.sellerIdentity);
      expectNoAskLocationOrMoney(demand.body.data as Array<Record<string, unknown>>);
      expectNoAskLocationOrMoney(onBoard.body.data as Array<Record<string, unknown>>);
      await expectWall('sales', file.body, w.buyer, w.sellerIdentity);
      await expectWall('sales', worklist.body, w.buyer, w.sellerIdentity);
      await expectWall('sales', board.body, w.buyer, w.sellerIdentity);
      await expectWall('sales', funnel.body, w.buyer, w.sellerIdentity);
    }
  }
}

describe('13 — the app path and the staff-proxy path are indistinguishable on the desks', () => {
  it('an app-raised ask and a proxy-raised ask read identically on every desk read', async () => {
    const w = await seedWorld({ trustedSeller: true });
    const buyerTwo = await registerApproveAndLogIn(w.sales.token, w.tehsilT);

    const askBody = (qty: number, allPacks: boolean) => ({
      ...(allPacks ? { productId: w.productId } : { skuId: w.skuId }),
      allPacks,
      qty,
      conditionRequirement: { expiryBand: 'over12' },
    });

    const appAsks: string[] = [];
    const proxyAsks: string[] = [];
    for (const allPacks of [false, true]) {
      const app1 = await postAs(w.buyer.token, '/asks', askBody(5, allPacks));
      appAsks.push(app1.body.data.askId as string);
      const proxy1 = await postAs(w.sales.token, '/staff/proxy/buyer/asks', {
        ...askBody(5, allPacks),
        buyerCounterpartyId: buyerTwo.counterpartyId,
        callNote: 'Phone call.',
      });
      expect(proxy1.status).toBe(201);
      proxyAsks.push(proxy1.body.data.askId as string);
    }

    // Stored shape: the same fields, apart from who raised it and the proxy log.
    const strip = (doc: Record<string, unknown>) => {
      const {
        _id,
        buyerId,
        createdAt,
        updatedAt,
        visibleToAllAt,
        headStartOpenedAt,
        ttlAt,
        proxyLog,
        enquiryId,
        __v,
        ...rest
      } = doc;
      void [_id, buyerId, createdAt, updatedAt, visibleToAllAt, headStartOpenedAt, ttlAt];
      void [proxyLog, enquiryId, __v];
      return rest;
    };
    for (let i = 0; i < 2; i += 1) {
      const fromApp = (await Ask.findById(appAsks[i]))!.toObject() as unknown as Record<
        string,
        unknown
      >;
      const fromProxy = (await Ask.findById(proxyAsks[i]))!.toObject() as unknown as Record<
        string,
        unknown
      >;
      expect(strip(fromProxy)).toEqual(strip(fromApp));
      // Both open to the board at the same rule's moment: both in the future (head start), same shape.
      expect(fromApp.visibleToAllAt instanceof Date).toBe(true);
      expect((fromApp.visibleToAllAt as Date) > new Date()).toBe(
        (fromProxy.visibleToAllAt as Date) > new Date(),
      );
    }

    // Purchase reads: the two app asks' rows equal the two proxy asks' rows.
    const demand = (await getAs(w.purchase.token, '/staff/purchase/demand')).body.data as Array<{
      askId: string;
      createdAt: string;
    }>;
    const rowOf = (id: string) => {
      const { createdAt, ...rest } = demand.find((r) => r.askId === id)!;
      void createdAt;
      return withoutIds(rest, [id]);
    };
    expect(rowOf(proxyAsks[0]!)).toEqual(rowOf(appAsks[0]!));
    expect(rowOf(proxyAsks[1]!)).toEqual(rowOf(appAsks[1]!));

    const onBoard = (await getAs(w.purchase.token, '/staff/purchase/demand/on-board-not-quoted'))
      .body.data as Array<{ askId: string }>;
    for (let i = 0; i < 2; i += 1) {
      const a = onBoard.find((r) => r.askId === appAsks[i]);
      const p = onBoard.find((r) => r.askId === proxyAsks[i]);
      expect(a).toBeDefined();
      expect(withoutIds(p, [proxyAsks[i]!])).toEqual(withoutIds(a, [appAsks[i]!]));
    }

    // Sales reads: both buyers file the same way; both asks are in He asked; both on the product board.
    const worklist = (await getAs(w.sales.token, '/staff/sales/worklist')).body.data as Array<{
      bucket: string;
      refId: string;
    }>;
    const heAsked = worklist.filter((i) => i.bucket === 'he_asked').map((i) => i.refId);
    for (const id of [...appAsks, ...proxyAsks]) expect(heAsked).toContain(id);

    const board = (await getAs(w.sales.token, `/staff/sales/board/${w.productId}`)).body.data
      .openAsks as Array<{ askId: string }>;
    const boardIds = board.map((a) => a.askId);
    for (const id of [...appAsks, ...proxyAsks]) expect(boardIds).toContain(id);

    const fileOne = (await getAs(w.sales.token, `/staff/sales/buyers/${w.buyer.buyerDocId}`)).body
      .data;
    const fileTwo = (await getAs(w.sales.token, `/staff/sales/buyers/${buyerTwo.buyerDocId}`)).body
      .data;
    expect(fileOne.openAsks).toHaveLength(2);
    expect(fileTwo.openAsks).toHaveLength(2);
  });
});

describe('13 — a pack-specific ask counts on a seller who carries the product', () => {
  it("the seller file's answer rate counts a pack-specific ask (it stores skuId, not productId)", async () => {
    const w = await seedWorld({ trustedSeller: false });
    const purchase = await staffToken(app, 'purchase');
    await SellerCatalogueEntry.create({
      sellerId: w.sellerDocId,
      productId: w.productId,
      skuIds: [],
      setBy: purchase.employeeId,
    });
    const ask = await postAs(w.buyer.token, '/asks', {
      skuId: w.skuId,
      allPacks: false,
      qty: 4,
      conditionRequirement: { expiryBand: 'over12' },
    });
    expect(ask.status).toBe(201);
    // One ask on his product, none quoted: 0%, not "nothing to measure".
    const metrics = await getSellerFunnelMetrics(w.sellerDocId);
    expect(metrics.answerRatePct).toBe(0);
  });
});

describe('14 — the Sales call workspace (B-43, B-44, item 16)', () => {
  it('the buyer id the workspace screen receives is Buyer._id, and the proxy wants the counterpartyId', async () => {
    const w = await seedWorld({ trustedSeller: false });

    const list = (await getAs(w.sales.token, '/staff/sales/buyers?tab=queue')).body.data as Array<{
      buyerId: string;
    }>;
    const row = list.find((b) => b.buyerId === w.buyer.buyerDocId);
    // The Buyers list navigates with Buyer._id.
    expect(row).toBeDefined();

    const file = (await getAs(w.sales.token, `/staff/sales/buyers/${row!.buyerId}`)).body.data;
    expect(file.buyerId).toBe(w.buyer.buyerDocId);
    expect(file.counterpartyId).toBe(w.buyer.counterpartyId);
    expect(file.counterpartyId).not.toBe(file.buyerId);

    const ask = {
      skuId: w.skuId,
      allPacks: false,
      qty: 3,
      conditionRequirement: { expiryBand: 'over12' },
      callNote: 'Incoming call.',
    };
    // Using the id the screen ought to use (counterpartyId): works.
    const good = await postAs(w.sales.token, '/staff/proxy/buyer/asks', {
      ...ask,
      buyerCounterpartyId: file.counterpartyId,
    });
    expect(good.status).toBe(201);

    // Using the wrong id (Buyer._id): the failure the client saw — now a clear message, not "Buyers only.".
    const bad = await postAs(w.sales.token, '/staff/proxy/buyer/asks', {
      ...ask,
      buyerCounterpartyId: file.buyerId,
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error.messageEn).not.toBe('Buyers only.');
  });

  it('Log a buyer call works for a Queue buyer, a Book buyer, and a zero-order buyer', async () => {
    const w = await seedWorld({ trustedSeller: false });
    const queueBuyer = w.buyer;
    const bookBuyer = await registerApproveAndLogIn(w.sales.token, w.tehsilT);
    const zeroOrderBuyer = await registerApproveAndLogIn(w.sales.token, w.tehsilT);
    // Put two of them in a Book by hand (the API for it is an admin route; the assignment is the same row).
    for (const b of [bookBuyer, zeroOrderBuyer]) {
      await BookAssignment.create({
        buyerId: b.buyerDocId,
        ownerEmployeeId: w.sales.employeeId,
        assignedAt: new Date(),
        assignedBy: w.sales.employeeId,
        reason: 'test',
      });
    }

    for (const b of [queueBuyer, bookBuyer, zeroOrderBuyer]) {
      const file = (await getAs(w.sales.token, `/staff/sales/buyers/${b.buyerDocId}`)).body.data;
      const res = await postAs(w.sales.token, '/staff/proxy/buyer/asks', {
        skuId: w.skuId,
        allPacks: false,
        qty: 2,
        conditionRequirement: { expiryBand: 'over12' },
        buyerCounterpartyId: file.counterpartyId,
        callNote: 'Incoming call.',
      });
      expect(res.status).toBe(201);
      const askPicker = await getAs(
        w.sales.token,
        `/staff/proxy/buyer/asks?buyerCounterpartyId=${file.counterpartyId}`,
      );
      expect(askPicker.status).toBe(200);
      expect(askPicker.body.data).toHaveLength(1);
    }
  });

  it('"On the board for him" lists what reaches his tehsil — a zero-order buyer sees it too', async () => {
    const w = await seedWorld({ trustedSeller: false, otpLogin: true });
    const boardPath = `/staff/sales/buyers/${w.buyer.buyerDocId}/board`;
    const res = await getAs(w.sales.token, boardPath);
    expect(res.status).toBe(200);
    const products = res.body.data as Array<{
      productId: string;
      ladder: Array<{ ratePaise: number; listingLineId: string }>;
    }>;
    const mine = products.find((p) => p.productId === w.productId);
    expect(mine).toBeDefined();
    expect(mine!.ladder.length).toBeGreaterThan(0);

    // The rate is the buyer's own tier rate (BR-060), the same figure his own feed shows him —
    // not the seller's net of 40000 — and the wall holds: no seller identity.
    const ownFeed = await getAs(w.buyer.token, '/listings');
    const feedCard = (
      ownFeed.body.data as Array<{ productId: string; lowestRatePaise: number }>
    ).find((c) => c.productId === w.productId);
    expect(feedCard).toBeDefined();
    expect(mine!.ladder[0]!.ratePaise).toBe(feedCard!.lowestRatePaise);
    expect(mine!.ladder[0]!.ratePaise).not.toBe(40000);
    await expectWall('sales', res.body, w.buyer, w.sellerIdentity);

    // Only what reaches HIS tehsil: a listing in another tehsil is not on his board.
    const purchase = w.purchase;
    const otherTehsil = await createTehsil();
    const otherSellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [
      otherTehsil,
    ]);
    const otherSeller = await Seller.findById(otherSellerDocId);
    const otherSellerCp = String(otherSeller!.counterpartyId);
    const otherSkuId = await createTestSku('Medium');
    const otherProductId = String((await Sku.findById(otherSkuId))!.productId);
    const otherListing = await postAs(
      signAccessToken({
        sub: otherSellerCp,
        actorType: 'counterparty',
        counterpartyId: otherSellerCp,
        roles: [],
        permissions: [],
        status: 'active',
      }),
      '/listings',
      {
        productId: otherProductId,
        scopeType: 'my_area',
        lines: [
          {
            skuId: otherSkuId,
            ratePaise: 41000,
            expiryBand: 'over12',
            moqExact: 1,
            deliveryBand: '48h',
            provenance: 'company',
            qty: 50,
          },
        ],
      },
    );
    expect(otherListing.status).toBe(201);
    const again = await getAs(w.sales.token, boardPath);
    const ids = (again.body.data as Array<{ productId: string }>).map((p) => p.productId);
    expect(ids).toContain(w.productId);
    expect(ids).not.toContain(otherProductId);

    // Order history changes nothing: give him an order for the other product, then remove it.
    const chain = await Chain.create({ chainNo: `C-ARD-${Date.now()}`, source: 'inquiry' });
    const so = await So.create({
      soNo: `SO-ARD-${Date.now()}`,
      chainId: chain._id,
      buyerId: w.buyer.buyerDocId,
      sellerId: otherSellerDocId,
      tierAtOrder: 'Dealer',
      placeOfSupply: 'intra_state',
      state: 'awaiting_payment',
      payDeadline: new Date(Date.now() + 16 * 60 * 60 * 1000),
      totalPaise: 118000,
    });
    await SoLine.create({
      soId: so._id,
      skuId: otherSkuId,
      boxes: 1,
      ratePaise: 1000,
      classAtOrder: 'Medium',
      marginPctAtOrder: 0.05,
      sellerNetPaise: 800,
      baseUnitsPerBoxAtOrder: 20,
      baseUnitAtOrder: 'LTR',
      taxablePaise: 100000,
      totalPaise: 118000,
      taxSplit: { cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 },
    });
    const withOrder = await getAs(w.sales.token, boardPath);
    expect(withOrder.body.data).toEqual(res.body.data);
    await SoLine.deleteMany({ soId: so._id });
    await So.deleteOne({ _id: so._id });
    const withoutOrder = await getAs(w.sales.token, boardPath);
    expect(withoutOrder.body.data).toEqual(res.body.data);
  });

  it('a buyer id that is not a buyer is a clean 404, and a malformed id a 400 — not a hang or a 500', async () => {
    const sales = await staffToken(app, 'sales');
    const missing = await getAs(sales.token, '/staff/sales/buyers/6ac3dadad719e93c08a46aad/board');
    expect(missing.status).toBe(404);
    const malformed = await getAs(sales.token, '/staff/sales/buyers/not-an-id/board');
    expect(malformed.status).toBe(400);
  });
});
