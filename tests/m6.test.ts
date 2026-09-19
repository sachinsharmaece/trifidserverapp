import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Ask } from '../src/models/Ask.js';
import { SellerDebit } from '../src/models/SellerDebit.js';
import { PromotionOffer } from '../src/models/PromotionOffer.js';
import { FailureEvent } from '../src/models/FailureEvent.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Refund } from '../src/models/Refund.js';
import { COMPLAINT_CATEGORIES } from '../src/models/Complaint.js';
import * as chainService from '../src/modules/chain/chain.service.js';
import * as dockService from '../src/modules/dock/dock.service.js';
import * as conductService from '../src/modules/conduct/conduct.service.js';
import * as purchaseService from '../src/modules/desk/purchase/purchase.service.js';
import * as salesService from '../src/modules/desk/sales/sales.service.js';
import { assertCounterpartyActive } from '../src/shared/guards.js';
import { computeAbsorptionCapPaise } from '../src/shared/pricing.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';
import * as paymentService from '../src/modules/payment/payment.service.js';

const app = createApp();

function idemKey(): string {
  return `m6-${Date.now()}-${Math.random()}`;
}

async function payInFull(
  soId: string,
  buyerId: string,
  actor: { employeeId: string; correlationId: string },
) {
  const so = await So.findById(soId);
  const buyer = await Buyer.findById(buyerId);
  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(
    (buyer!._id as unknown as string).toString(),
    { amountPaise: so!.totalPaise, method: 'utr', utr: `M6UTR${Date.now()}` },
  );
  await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], actor);
  await paymentService.postBankCredit(
    upcomingReceiptId,
    {
      utr: `M6UTR${Date.now()}`,
      remitterAccountNumber: '000900012345678',
      remitterIfsc: 'HDFC0001234',
    },
    actor,
  );
}

describe('M6 — WF-11 the fallback/absorption workflow', () => {
  it('promotes a cheaper replacement seller, the buyer accepts, the clock restarts at acceptance', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const actor = { employeeId: admin.employeeId, correlationId: idemKey() };

    const tehsil = await createTehsil();
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.02, admin.employeeId);

    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const failedSellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const cheaperSellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const failedSeller = await Seller.findById(failedSellerId);
    const cheaperSeller = await Seller.findById(cheaperSellerId);

    const buyer = await Buyer.findById(buyerId);
    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);

    const { soId } = await chainService.createSo(
      {
        buyerId,
        sellerId: failedSellerId,
        skuId,
        boxes: 10,
        sellerNetPaise: 40000, // ₹400/unit taxable.
        placeOfSupply: 'intra_state',
      },
      actor,
    );

    await payInFull(soId, buyerId, actor);
    const { poId } = await chainService.createPo(soId, actor);

    // A real, live, cheaper listing line for the same SKU, from a different
    // (active) seller — the WF-11 candidate. The failed seller deliberately
    // has no listing at all, since `createSo` (this milestone's manual entry
    // point) does not itself require one.
    const listing = await Listing.create({
      sellerId: cheaperSeller!._id,
      productId: sku!.productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [tehsil],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId,
      ratePaise: 39000, // Cheaper than the failed seller's ₹400 — always affordable.
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 100,
    });

    // Whole-lot rejection at the dock — BR-186/WF-11's trigger.
    await dockService.recordInspection(
      poId,
      { casesAccepted: 0, casesRejected: 10, reasons: ['case_count_short'], photoRefs: ['ref'] },
      actor,
    );
    const result = await dockService.applyInspection(poId, actor);
    expect(result.soState).toBe('promotion_offered');
    expect(result.promotionOfferId).toBeTruthy();

    const offer = await PromotionOffer.findById(result.promotionOfferId);
    expect(offer!.status).toBe('pending');
    expect(offer!.promotedSellerId.toString()).toBe(cheaperSellerId);
    expect(offer!.deltaPaise).toBe(0); // Cheaper, not dearer — nothing to absorb.

    const soBefore = await So.findById(soId);
    expect(soBefore!.state).toBe('promotion_offered');

    await chainService.acceptPromotionOffer(
      soId,
      (buyer!.counterpartyId as unknown as string).toString(),
      idemKey(),
    );

    const soAfter = await So.findById(soId);
    expect(soAfter!.state).toBe('po_released');
    expect(soAfter!.sellerId.toString()).toBe(cheaperSellerId);
    expect(soAfter!.totalPaise).toBe(soBefore!.totalPaise); // BR-301 — the buyer's own total never moved.

    const poAfter = await Po.findById(poId);
    expect(poAfter!.state).toBe('released');
    expect(poAfter!.failed).toBe(false);
    // WF-11 — the 48h clock starts at acceptance, not the original PO release.
    expect(poAfter!.dispatchDueDate.getTime()).toBeGreaterThan(Date.now() - 5000);

    const finalOffer = await PromotionOffer.findById(result.promotionOfferId);
    expect(finalOffer!.status).toBe('accepted');

    // No debit — the replacement was cheaper, nothing to recover.
    const debits = await SellerDebit.find({ counterpartyId: failedSellerId });
    expect(debits.length).toBe(0);

    // BR-215 — the failed seller still took a counted failure.
    const failures = await FailureEvent.find({
      counterpartyId: (failedSeller!.counterpartyId as unknown as string).toString(),
    });
    expect(failures.some((f) => f.type === 'seller_whole_lot_rejection_fault')).toBe(true);
  });

  it('no affordable candidate resolves straight to a full refund, exactly the pre-M6 path', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const actor = { employeeId: admin.employeeId, correlationId: idemKey() };

    const tehsil = await createTehsil();
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.02, admin.employeeId);

    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const failedSellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);

    // No listing from any other seller exists on this SKU at all — WF-11
    // must find no candidate and refund outright, exactly the pre-M6 path.
    const { soId } = await chainService.createSo(
      {
        buyerId,
        sellerId: failedSellerId,
        skuId,
        boxes: 5,
        sellerNetPaise: 40000,
        placeOfSupply: 'intra_state',
      },
      actor,
    );
    await payInFull(soId, buyerId, actor);
    const { poId } = await chainService.createPo(soId, actor);

    const result = await chainService.transitionToSupplyFailed(soId, poId, actor);
    expect(result.promotionOfferId).toBeUndefined();
    expect(result.refundId).toBeTruthy();

    const refund = await Refund.findById(result.refundId);
    expect(refund!.amountPaise).toBe((await So.findById(soId))!.totalPaise);

    const soAfter = await So.findById(soId);
    expect(soAfter!.state).toBe('supply_failed');
  });

  it('a declined or expired offer restores an ask-originated order to standing demand, not dead-ended', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const actor = { employeeId: admin.employeeId, correlationId: idemKey() };

    const tehsil = await createTehsil();
    const skuId = await createTestSku('B');
    await seedMarginCell('B', 'Dealer', 0.02, admin.employeeId);

    const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const failedSellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const cheaperSellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const buyer = await Buyer.findById(buyerId);
    const failedSeller = await Seller.findById(failedSellerId);
    const cheaperSeller = await Seller.findById(cheaperSellerId);
    const { Sku } = await import('../src/models/Sku.js');
    const sku = await Sku.findById(skuId);

    const demandService = await import('../src/modules/demand/demand.service.js');
    const buyerCounterpartyId = (buyer!.counterpartyId as unknown as string).toString();
    const failedSellerCounterpartyId = (
      failedSeller!.counterpartyId as unknown as string
    ).toString();

    const { askId } = await demandService.raiseAsk(buyerCounterpartyId, {
      skuId,
      allPacks: false,
      qty: 5,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const { quoteId } = await demandService.postQuote(failedSellerCounterpartyId, askId, {
      ratePaiseForIndore: 40000,
      qtyAvailable: 5,
      expiryBand: 'over12',
      expiryExact: '12/2027',
      deliveryBand: '2-5d',
      provenance: 'company',
      daysToIndore: 2,
    });
    const { soIds } = await demandService.acceptAskFill(
      buyerCounterpartyId,
      askId,
      { option: 'full', quoteIds: [quoteId] },
      idemKey(),
    );
    const soId = soIds[0]!;
    expect((await So.findById(soId))!.askId?.toString()).toBe(askId);
    expect((await Ask.findById(askId))!.state).toBe('converted');

    await payInFull(soId, buyerId, actor);
    const { poId } = await chainService.createPo(soId, actor);

    // A cheaper live listing exists, so a promotion offer is made this time...
    const listing = await Listing.create({
      sellerId: cheaperSeller!._id,
      productId: sku!.productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [tehsil],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId,
      ratePaise: 39000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 100,
    });

    await dockService.recordInspection(
      poId,
      { casesAccepted: 0, casesRejected: 5, reasons: ['case_count_short'], photoRefs: ['ref'] },
      actor,
    );
    const result = await dockService.applyInspection(poId, actor);
    expect(result.promotionOfferId).toBeTruthy();

    // ...but the buyer declines it rather than accepting.
    await chainService.rejectPromotionOffer(soId, buyerCounterpartyId);

    const soAfter = await So.findById(soId);
    expect(soAfter!.state).toBe('supply_failed');
    const askAfter = await Ask.findById(askId);
    expect(askAfter!.state).toBe('open'); // BR-021 — restored to standing demand, not dead-ended.
  });

  it('zero margin refuses absorption — the cap can never exceed the margin on the line', () => {
    expect(computeAbsorptionCapPaise(1_00_000_00, 0)).toBe(0);
    // Any candidate dearer than the zero-margin baseline is therefore never affordable.
  });
});

describe('M6 — conduct: grace, strikes, blacklist', () => {
  it('three strikes blacklists a counterparty, blocking new activity but not what is already in flight', async () => {
    const admin = await staffToken(app, 'admin');
    const sales = await staffToken(app, 'sales');
    const purchase = await staffToken(app, 'purchase');
    const actor = { employeeId: admin.employeeId, correlationId: idemKey() };

    const tehsil = await createTehsil();
    const sellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const seller = await Seller.findById(sellerId);
    const counterpartyId = (seller!.counterpartyId as unknown as string).toString();

    // Zero trailing commitments → grace allowance is exactly 1 (BR-210). The
    // very first failure is absorbed by that allowance (`logged`, BR-212 —
    // nothing else happens) and is deliberately not walked anywhere; every
    // failure after it enters at `warning` and is walked to `strike`.
    await conductService.recordFailure(
      { counterpartyId, counterpartyKind: 'seller', type: 'seller_no_dispatch_48h' },
      actor,
    );
    async function toStrike(failureEventId: string) {
      await conductService.advanceConductStage(failureEventId, 'cure_period', 'test', {
        employeeId: admin.employeeId,
        checkerEmployeeId: sales.employeeId,
        correlationId: idemKey(),
      });
      return conductService.advanceConductStage(failureEventId, 'strike', 'test', {
        employeeId: admin.employeeId,
        checkerEmployeeId: sales.employeeId,
        correlationId: idemKey(),
      });
    }

    const f1 = await conductService.recordFailure(
      { counterpartyId, counterpartyKind: 'seller', type: 'seller_no_dispatch_48h' },
      actor,
    );
    expect(f1.stage).toBe('warning'); // Grace is spent — this one is real.
    await toStrike(f1.failureEventId);
    const f2 = await conductService.recordFailure(
      { counterpartyId, counterpartyKind: 'seller', type: 'seller_no_dispatch_48h' },
      actor,
    );
    await toStrike(f2.failureEventId);
    const f3 = await conductService.recordFailure(
      { counterpartyId, counterpartyKind: 'seller', type: 'seller_no_dispatch_48h' },
      actor,
    );
    const third = await toStrike(f3.failureEventId);
    expect(third.blacklisted).toBe(true);

    const counterparty = await Counterparty.findById(counterpartyId);
    expect(counterparty!.status).toBe('blacklisted');

    // New activity blocked.
    await expect(assertCounterpartyActive(counterpartyId)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ACTIVE',
    });
  });

  it('fraud skips the ladder entirely — immediate blacklist, no cure, no decay', async () => {
    const admin = await staffToken(app, 'admin');
    const purchase = await staffToken(app, 'purchase');
    const actor = { employeeId: admin.employeeId, correlationId: idemKey() };
    const tehsil = await createTehsil();
    const sellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
    const seller = await Seller.findById(sellerId);
    const counterpartyId = (seller!.counterpartyId as unknown as string).toString();

    const result = await conductService.recordFailure(
      {
        counterpartyId,
        counterpartyKind: 'seller',
        type: 'seller_whole_lot_rejection_fault',
        viaFraud: true,
      },
      actor,
    );
    expect(result.blacklisted).toBe(true);
    expect(result.stage).toBe('strike');
    const event = await FailureEvent.findById(result.failureEventId);
    expect(event!.decaysAt).toBeNull(); // BR-217 — fraud never decays.
  });
});

describe('M6 — the wall, re-verified for Purchase and Sales', () => {
  it('the absorption queue never carries the cap or the two source rates (IC-06)', async () => {
    const items = await purchaseService.getAbsorptionQueue();
    for (const item of items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain('capPaise');
      expect(keys).not.toContain('failedSellerNetPaise');
      expect(keys).not.toContain('promotedSellerNetPaise');
      expect(keys.sort()).toEqual(
        ['deltaPaise', 'expiresAt', 'offeredAt', 'soId', 'status', 'withinCap'].sort(),
      );
    }
  });

  it('the active demand list carries no buyer identity and no rupee figure (BR-069)', async () => {
    const items = await purchaseService.getActiveDemandList({});
    for (const item of items) {
      const json = JSON.stringify(item);
      expect(json).not.toMatch(/buyerId/i);
      expect(json).not.toMatch(/ratePaise|totalPaise|Paise":\d/);
    }
  });

  it('an MSP response never carries a floor, a limit or a margin (IC-07)', async () => {
    const buyerToken = await staffToken(app, 'sales'); // Placeholder actor for buyer creation below.
    const tehsil = await createTehsil();
    const buyerId = await createApprovedBuyerAtTehsil(app, buyerToken.token, tehsil, 'dealer');
    const buyer = await Buyer.findById(buyerId);
    const skuId = await createTestSku('B');

    await salesService.requestMsp((buyer!.counterpartyId as unknown as string).toString(), {
      skuId,
      qty: 5,
    });
    const admin = await staffToken(app, 'admin');
    const rows = await salesService.getMspQueue();
    const mine = rows.find((r) => r.buyerId === buyerId);
    expect(mine).toBeTruthy();
    await salesService.respondToMsp(
      mine!.mspRequestId,
      { granted: false, refusalCode: 'already_at_the_best_available_rate' },
      { employeeId: admin.employeeId, correlationId: idemKey() },
    );
    const responses = await salesService.listMyMspRequests(
      (buyer!.counterpartyId as unknown as string).toString(),
    );
    const json = JSON.stringify(responses);
    expect(json.toLowerCase()).not.toMatch(/floor|limit|margin/);
  });
});

describe('M6 — complaint routing (BR-201)', () => {
  // Corrected M7 (QR-048/BR-206): "Controller decides disputes" — four of
  // the five categories now route to Controller's own dispute queue, not
  // straight to an execution desk; `transit_damage` is `'unhandled'` this
  // session (QR-050 — BR-180's strike-on-refusal clause untouched).
  it('routes each of the five categories to a fixed destination', () => {
    const destinations = COMPLAINT_CATEGORIES.map((c) => salesService.destinationForComplaint(c));
    expect(destinations).toEqual([
      'unhandled',
      'controller',
      'controller',
      'controller',
      'controller',
    ]);
  });
});
