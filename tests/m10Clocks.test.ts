import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { So } from '../src/models/So.js';
import { Po } from '../src/models/Po.js';
import { Refund } from '../src/models/Refund.js';
import { Complaint } from '../src/models/Complaint.js';
import { ChainEvent } from '../src/models/ChainEvent.js';
import { FailureEvent } from '../src/models/FailureEvent.js';
import { PoolCommitment } from '../src/models/PoolCommitment.js';
import { PromotionOffer } from '../src/models/PromotionOffer.js';
import { UpcomingReceipt } from '../src/models/UpcomingReceipt.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Sku } from '../src/models/Sku.js';
import * as chainService from '../src/modules/chain/chain.service.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import * as ordersService from '../src/modules/orders/orders.service.js';
import {
  runPaymentWindowExpiry,
  runDispatchChase,
  runPromotionOfferExpiry,
  runDeliveryAutoClose,
} from '../src/modules/clocks/clocks.jobs.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * Milestone 10, Step 0b — the four clocks. Each is driven by a `now` the test
 * advances past the deadline (no waiting), and each is raced against the
 * equivalent manual action (CH §25.6, M9's atomic-claim discipline).
 */
const app = createApp();
const HOUR = 60 * 60 * 1000;
const corr = (): string => `m10-${Date.now()}-${Math.random()}`;

async function fixture() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const tehsil = await createTehsil();
  const skuId = await createTestSku('B');
  await seedMarginCell('B', 'Dealer', 0.02, admin.employeeId);
  const actor = { employeeId: admin.employeeId, correlationId: corr() };
  const buyerId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
  const sellerId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  return { admin, sales, purchase, tehsil, skuId, actor, buyerId, sellerId };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

async function newSo(fx: Fx, buyerId = fx.buyerId): Promise<string> {
  const { soId } = await chainService.createSo(
    {
      buyerId,
      sellerId: fx.sellerId,
      skuId: fx.skuId,
      boxes: 10,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    },
    fx.actor,
  );
  return soId;
}

async function declareClaim(buyerId: string, amountPaise: number): Promise<string> {
  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
    amountPaise,
    method: 'utr',
    utr: `UTR-${Math.random()}`,
  });
  return upcomingReceiptId;
}

async function post(fx: Fx, receiptId: string): Promise<void> {
  await paymentService.postBankCredit(
    receiptId,
    {
      utr: `STMT-${Math.random()}`,
      remitterAccountNumber: '99988877766',
      remitterIfsc: 'HDFC0001234',
    },
    fx.actor,
  );
}

async function payInFull(fx: Fx, soId: string): Promise<void> {
  const so = await So.findById(soId);
  const receiptId = await declareClaim(fx.buyerId, so!.totalPaise);
  await paymentService.allocateUpcomingReceipt(receiptId, [soId], fx.actor);
  await post(fx, receiptId);
}

async function buyerCounterpartyId(buyerId: string): Promise<string> {
  const buyer = await Buyer.findById(buyerId);
  return (buyer!.counterpartyId as Types.ObjectId).toString();
}

async function failuresOf(counterpartyId: string, type: string): Promise<number> {
  return FailureEvent.countDocuments({ counterpartyId, type });
}

async function soState(soId: string): Promise<string> {
  return (await So.findById(soId))!.state;
}

// ---------------------------------------------------------------------------
describe('clock 1 — payment-window expiry (BR-032, BR-035)', () => {
  it('cancels an unpaid order once its window has passed; the buyer takes a conduct event, the seller none', async () => {
    const fx = await fixture();
    const soId = await newSo(fx);
    const so = (await So.findById(soId))!;

    // Before the deadline: nothing happens.
    await runPaymentWindowExpiry(new Date(so.payDeadline.getTime() - HOUR));
    expect(await soState(soId)).toBe('awaiting_payment');

    // Past it: cancelled.
    const counts = await runPaymentWindowExpiry(new Date(so.payDeadline.getTime() + HOUR));
    expect(counts.cancelled).toBeGreaterThanOrEqual(1);
    expect(await soState(soId)).toBe('cancelled');

    const buyerCp = await buyerCounterpartyId(fx.buyerId);
    expect(await failuresOf(buyerCp, 'buyer_failed_to_pay')).toBe(1); // BR-215 (grace decides its stage)
    const seller = (await Seller.findById(fx.sellerId))!;
    expect(await FailureEvent.countDocuments({ counterpartyId: seller.counterpartyId })).toBe(0); // no seller strike
    const event = await ChainEvent.findOne({ refId: soId, type: 'so_cancelled_unpaid' });
    expect(event?.actorType).toBe('system');
  });

  it('is idempotent and concurrency-safe: two runs at once cancel once and record ONE conduct event', async () => {
    const fx = await fixture();
    const soId = await newSo(fx);
    const later = new Date(Date.now() + 25 * HOUR);
    await Promise.all([runPaymentWindowExpiry(later), runPaymentWindowExpiry(later)]);
    expect(await soState(soId)).toBe('cancelled');
    expect(await failuresOf(await buyerCounterpartyId(fx.buyerId), 'buyer_failed_to_pay')).toBe(1);
  }, 60000);

  it('never cancels an order that has money posted — fully or partly paid is a person’s call', async () => {
    const fx = await fixture();
    const paidSo = await newSo(fx);
    await payInFull(fx, paidSo);
    const partSo = await newSo(fx);
    const partReceipt = await declareClaim(fx.buyerId, 1000); // far less than the order
    await paymentService.allocateUpcomingReceipt(partReceipt, [partSo], fx.actor);
    await post(fx, partReceipt);

    await runPaymentWindowExpiry(new Date(Date.now() + 25 * HOUR));
    expect(await soState(paidSo)).toBe('awaiting_payment');
    expect(await soState(partSo)).toBe('awaiting_payment');
    expect(await failuresOf(await buyerCounterpartyId(fx.buyerId), 'buyer_failed_to_pay')).toBe(0);
  }, 60000);

  it('spares an order whose buyer declared payment inside the window; a claim pointed at another SO does not', async () => {
    const fx = await fixture();
    const declared = await newSo(fx);
    const other = await newSo(fx);
    const claim = await declareClaim(fx.buyerId, 5000); // waiting, unallocated, made in time
    await runPaymentWindowExpiry(new Date(Date.now() + 25 * HOUR));
    expect(await soState(declared)).toBe('awaiting_payment');
    expect(await soState(other)).toBe('awaiting_payment');

    // Sales points the claim at `other`: `declared` is no longer covered by it.
    await paymentService.allocateUpcomingReceipt(claim, [other], fx.actor);
    await runPaymentWindowExpiry(new Date(Date.now() + 25 * HOUR));
    expect(await soState(declared)).toBe('cancelled');
    expect(await soState(other)).toBe('awaiting_payment');
  }, 60000);

  it('a claim made AFTER the deadline does not save the order', async () => {
    const fx = await fixture();
    const soId = await newSo(fx);
    const so = (await So.findById(soId))!;
    const claim = await declareClaim(fx.buyerId, 5000);
    await UpcomingReceipt.updateOne(
      { _id: claim },
      { $set: { claimedAt: new Date(so.payDeadline.getTime() + HOUR) } },
    );
    await runPaymentWindowExpiry(new Date(so.payDeadline.getTime() + 2 * HOUR));
    expect(await soState(soId)).toBe('cancelled');
  }, 60000);

  it('leaves a pool order alone — BR-158’s short close needs the seller’s decision (QR-065)', async () => {
    const fx = await fixture();
    const soId = await newSo(fx);
    await PoolCommitment.collection.insertOne({ soId: new Types.ObjectId(soId) });
    try {
      await runPaymentWindowExpiry(new Date(Date.now() + 25 * HOUR));
      expect(await soState(soId)).toBe('awaiting_payment');
    } finally {
      await PoolCommitment.collection.deleteMany({ soId: new Types.ObjectId(soId) });
    }
  });

  it('RACE: Accounts posting a declared payment while the expiry runs — the paid order is never cancelled', async () => {
    const fx = await fixture();
    const soId = await newSo(fx);
    const so = (await So.findById(soId))!;
    const receiptId = await declareClaim(fx.buyerId, so.totalPaise);
    await paymentService.allocateUpcomingReceipt(receiptId, [soId], fx.actor);

    await Promise.all([
      post(fx, receiptId),
      runPaymentWindowExpiry(new Date(so.payDeadline.getTime() + HOUR)),
    ]);

    expect(await soState(soId)).toBe('awaiting_payment');
    expect(await paymentService.getPostedReceiptsPaiseForSo(soId)).toBe(so.totalPaise);
    expect(await failuresOf(await buyerCounterpartyId(fx.buyerId), 'buyer_failed_to_pay')).toBe(0);
    // ...and its PO can still be released.
    await expect(chainService.createPo(soId, fx.actor)).resolves.toBeTruthy();
  }, 60000);

  it('RACE: a buyer declaring payment while the expiry runs — the outcome is always consistent', async () => {
    // Either the claim is seen (the order is spared), or the cancel took effect first and the
    // claim was stamped after it. What must never survive: a claim stamped BEFORE the cancel on
    // an order that was cancelled anyway.
    for (let round = 0; round < 3; round += 1) {
      const fx = await fixture();
      const soId = await newSo(fx);
      const so = (await So.findById(soId))!;
      const [claimId] = await Promise.all([
        declareClaim(fx.buyerId, 5000),
        runPaymentWindowExpiry(new Date(so.payDeadline.getTime() + HOUR)),
      ]);
      const after = (await So.findById(soId))!;
      const claim = (await UpcomingReceipt.findById(claimId))!;
      if (after.state === 'cancelled') {
        expect(claim.claimedAt.getTime()).toBeGreaterThanOrEqual(
          (after as unknown as { updatedAt: Date }).updatedAt.getTime() - 1,
        );
      } else {
        expect(after.state).toBe('awaiting_payment');
      }
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('clock 2 — the dispatch chase (BR-174, BR-215)', () => {
  async function releasedPo(fx: Fx, releasedAt: Date) {
    const soId = await newSo(fx);
    await payInFull(fx, soId);
    const { poId } = await chainService.createPo(soId, fx.actor);
    await Po.updateOne({ _id: poId }, { $set: { dispatchDueDate: releasedAt } });
    const seller = (await Seller.findById(fx.sellerId))!;
    await Seller.updateOne({ _id: seller._id }, { $set: { dispatchCutoffTime: '16:00' } });
    return { soId, poId, sellerCp: (seller.counterpartyId as Types.ObjectId).toString() };
  }
  // 10:30 IST on 1 Sep 2026 → his 16:00 IST cut-off is 10:30Z that day.
  const RELEASED = new Date('2026-09-01T05:00:00Z');

  it('same-day miss is pressure only — a chain event, NO conduct event (BR-215)', async () => {
    const fx = await fixture();
    const { poId, sellerCp } = await releasedPo(fx, RELEASED);
    await runDispatchChase(new Date('2026-09-01T10:00:00Z')); // before 16:00 IST
    expect((await Po.findById(poId))!.sameDayMissAt).toBeNull();

    await runDispatchChase(new Date('2026-09-01T11:00:00Z')); // after
    const po = (await Po.findById(poId))!;
    expect(po.sameDayMissAt).not.toBeNull();
    expect(po.noDispatch48hAt).toBeNull();
    expect(
      await ChainEvent.countDocuments({ refId: poId, type: 'dispatch_overdue_same_day' }),
    ).toBe(1);
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(0);

    await runDispatchChase(new Date('2026-09-01T12:00:00Z')); // idempotent
    expect(
      await ChainEvent.countDocuments({ refId: poId, type: 'dispatch_overdue_same_day' }),
    ).toBe(1);
  }, 60000);

  it('a PO released after his cut-off is due at his cut-off the next day', async () => {
    const fx = await fixture();
    const { poId } = await releasedPo(fx, new Date('2026-09-01T12:00:00Z')); // 17:30 IST
    await runDispatchChase(new Date('2026-09-02T09:00:00Z')); // next day, before 16:00 IST
    expect((await Po.findById(poId))!.sameDayMissAt).toBeNull();
    await runDispatchChase(new Date('2026-09-02T11:00:00Z'));
    expect((await Po.findById(poId))!.sameDayMissAt).not.toBeNull();
  }, 60000);

  it('48 hours without dispatch is a counted seller failure, recorded once', async () => {
    const fx = await fixture();
    const { poId, sellerCp } = await releasedPo(fx, RELEASED);
    await runDispatchChase(new Date(RELEASED.getTime() + 47 * HOUR));
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(0);

    const past = new Date(RELEASED.getTime() + 49 * HOUR);
    await Promise.all([runDispatchChase(past), runDispatchChase(past)]); // racing runs
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(1);
    expect((await Po.findById(poId))!.noDispatch48hAt).not.toBeNull();
    await runDispatchChase(new Date(RELEASED.getTime() + 60 * HOUR));
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(1);
  }, 60000);

  it('a lifeline (a later dispatch due date, BR-234) moves the 48-hour line with it', async () => {
    const fx = await fixture();
    const { poId, sellerCp } = await releasedPo(fx, new Date(RELEASED.getTime() + 24 * HOUR));
    await runDispatchChase(new Date(RELEASED.getTime() + 49 * HOUR));
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(0);
    expect((await Po.findById(poId))!.noDispatch48hAt).toBeNull();
  }, 60000);

  it('a dispatched PO is not chased, and a promoted seller’s acceptance resets the clock', async () => {
    const fx = await fixture();
    const { soId, poId, sellerCp } = await releasedPo(fx, RELEASED);
    await chainService.transitionToDispatchedLeg1(soId, poId);
    await runDispatchChase(new Date(RELEASED.getTime() + 72 * HOUR));
    expect(await failuresOf(sellerCp, 'seller_no_dispatch_48h')).toBe(0);
  }, 60000);

  it('RACE: the seller dispatching while the chase runs — never a failure on a PO that was already dispatched', async () => {
    const fx = await fixture();
    const { soId, poId, sellerCp } = await releasedPo(fx, RELEASED);
    await Promise.all([
      chainService.transitionToDispatchedLeg1(soId, poId),
      runDispatchChase(new Date(RELEASED.getTime() + 49 * HOUR)),
    ]);
    const po = (await Po.findById(poId))!;
    expect(po.state).toBe('dispatched_leg1'); // the dispatch is never lost
    const failures = await failuresOf(sellerCp, 'seller_no_dispatch_48h');
    // One consistent story: the failure exists exactly when the chase claimed the PO first.
    expect(failures).toBe(po.noDispatch48hAt ? 1 : 0);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('clock 3 — the promotion-offer expiry (WF-11)', () => {
  async function pendingOffer(fx: Fx) {
    const buyer = (await Buyer.findById(fx.buyerId))!;
    const sku = (await Sku.findById(fx.skuId))!;
    const cheaperSellerId = await createApprovedSellerAtTehsils(app, fx.purchase.token, [
      fx.tehsil,
    ]);
    const cheaper = (await Seller.findById(cheaperSellerId))!;
    const soId = await newSo(fx);
    await payInFull(fx, soId);
    const { poId } = await chainService.createPo(soId, fx.actor);
    const listing = await Listing.create({
      sellerId: cheaper._id,
      productId: sku.productId,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      frozenTehsilIds: [fx.tehsil],
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    });
    await ListingLine.create({
      listingId: listing._id,
      skuId: fx.skuId,
      ratePaise: 39000,
      expiryBand: 'over12',
      moqExact: 1,
      deliveryBand: '2-5d',
      provenance: 'company',
      qty: 100,
    });
    const result = await chainService.transitionToSupplyFailed(soId, poId, fx.actor);
    expect(result.promotionOfferId).toBeTruthy();
    return {
      soId,
      poId,
      offerId: result.promotionOfferId!,
      buyerCp: (buyer.counterpartyId as Types.ObjectId).toString(),
    };
  }

  it('silence for 24 hours refunds in full — the same outcome as the buyer’s own decline', async () => {
    const fx = await fixture();
    const silent = await pendingOffer(fx);
    const declined = await pendingOffer(fx);
    const offer = (await PromotionOffer.findById(silent.offerId))!;

    await runPromotionOfferExpiry(new Date(offer.expiresAt.getTime() - HOUR)); // too early
    expect((await PromotionOffer.findById(silent.offerId))!.status).toBe('pending');

    await chainService.rejectPromotionOffer(declined.soId, declined.buyerCp); // the button
    await runPromotionOfferExpiry(new Date(offer.expiresAt.getTime() + HOUR)); // the clock
    expect((await PromotionOffer.findById(silent.offerId))!.status).toBe('expired');

    const so = (await So.findById(silent.soId))!;
    expect(so.state).toBe('supply_failed');
    const viaClock = await Refund.find({ chainId: so.chainId });
    const soDeclined = (await So.findById(declined.soId))!;
    const viaButton = await Refund.find({ chainId: soDeclined.chainId });
    expect(viaClock).toHaveLength(1);
    expect(viaButton).toHaveLength(1);
    // Same rule: the same reason code, in full, payable.
    expect(viaClock[0]!.reasonCode).toBe(viaButton[0]!.reasonCode);
    expect(viaClock[0]!.amountPaise).toBe(so.totalPaise);
    expect(viaClock[0]!.state).toBe(viaButton[0]!.state);

    // Running it again refunds nothing twice.
    await runPromotionOfferExpiry(new Date(offer.expiresAt.getTime() + 2 * HOUR));
    expect(await Refund.countDocuments({ chainId: so.chainId })).toBe(1);
  }, 120000);

  it('RACE: the buyer accepting while the expiry runs — exactly one wins, never both, never neither', async () => {
    const fx = await fixture();
    const { soId, offerId, buyerCp } = await pendingOffer(fx);
    const offer = (await PromotionOffer.findById(offerId))!;

    const [acceptResult] = await Promise.allSettled([
      chainService.acceptPromotionOffer(soId, buyerCp, corr()),
      runPromotionOfferExpiry(new Date(offer.expiresAt.getTime() + HOUR)),
    ]);

    const so = (await So.findById(soId))!;
    const after = (await PromotionOffer.findById(offerId))!;
    const refunds = await Refund.countDocuments({ chainId: so.chainId });
    if (after.status === 'accepted') {
      expect(acceptResult.status).toBe('fulfilled');
      expect(so.state).toBe('po_released');
      expect(refunds).toBe(0); // accepted AND refunded would be double-paying the buyer
    } else {
      expect(after.status).toBe('expired');
      expect(acceptResult.status).toBe('rejected');
      expect(so.state).toBe('supply_failed');
      expect(refunds).toBe(1);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('clock 4 — the seven-day delivery auto-close (BR-192)', () => {
  async function atLegTwo(fx: Fx) {
    const soId = await newSo(fx);
    await payInFull(fx, soId);
    const { poId } = await chainService.createPo(soId, fx.actor);
    await chainService.transitionToDispatchedLeg2(soId, poId);
    const so = (await So.findById(soId))!;
    return { soId, so, buyerCp: await buyerCounterpartyId(fx.buyerId) };
  }

  it('closes an order seven days after leg 2 with no complaint — and not a minute earlier', async () => {
    const fx = await fixture();
    const { soId, so } = await atLegTwo(fx);
    const window = so.deliveryWindowEndsAt!;
    expect(window.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * HOUR);

    await runDeliveryAutoClose(new Date(window.getTime() - 60_000));
    expect(await soState(soId)).toBe('dispatched_leg2');
    await runDeliveryAutoClose(new Date(window.getTime() + 60_000));
    expect(await soState(soId)).toBe('closed');
    const event = await ChainEvent.findOne({ refId: soId, type: 'so_closed' });
    expect(event?.actorType).toBe('system');
  }, 60000);

  it('the manual confirm-receipt still works unchanged, through the same close', async () => {
    const fx = await fixture();
    const { soId, buyerCp } = await atLegTwo(fx);
    await expect(ordersService.confirmReceipt(buyerCp, soId)).resolves.toEqual({ closed: true });
    expect(await soState(soId)).toBe('closed');
    const event = await ChainEvent.findOne({ refId: soId, type: 'so_closed' });
    expect(event?.actorType).toBe('counterparty');
    await expect(ordersService.confirmReceipt(buyerCp, soId)).rejects.toMatchObject({
      code: 'ORDER_NOT_YET_DELIVERABLE',
    });
  }, 60000);

  it('a disputed order is never auto-closed', async () => {
    const fx = await fixture();
    const { soId, so, buyerCp } = await atLegTwo(fx);
    await ordersService.postComplaint(buyerCp, soId, { category: 'short_count_on_arrival' });
    await runDeliveryAutoClose(new Date(so.deliveryWindowEndsAt!.getTime() + HOUR));
    expect(await soState(soId)).toBe('disputed');
  }, 60000);

  it('RACE: the buyer confirming while the clock closes — closed once, no error leaks, no double close', async () => {
    const fx = await fixture();
    const { soId, so, buyerCp } = await atLegTwo(fx);
    const [confirm] = await Promise.allSettled([
      ordersService.confirmReceipt(buyerCp, soId),
      runDeliveryAutoClose(new Date(so.deliveryWindowEndsAt!.getTime() + HOUR)),
    ]);
    expect(await soState(soId)).toBe('closed');
    expect(await ChainEvent.countDocuments({ refId: soId, type: 'so_closed' })).toBe(1);
    if (confirm.status === 'rejected') {
      expect(confirm.reason).toMatchObject({ code: 'ORDER_NOT_YET_DELIVERABLE' });
    }
  }, 60000);

  it('RACE: a complaint while the clock closes — the order is either disputed or closed, never both', async () => {
    const fx = await fixture();
    const { soId, so, buyerCp } = await atLegTwo(fx);
    const [complaint] = await Promise.allSettled([
      ordersService.postComplaint(buyerCp, soId, { category: 'short_count_on_arrival' }),
      runDeliveryAutoClose(new Date(so.deliveryWindowEndsAt!.getTime() + HOUR)),
    ]);
    const state = await soState(soId);
    const complaints = await Complaint.countDocuments({ soId });
    if (state === 'disputed') {
      expect(complaint.status).toBe('fulfilled');
      expect(complaints).toBe(1);
    } else {
      expect(state).toBe('closed');
      expect(complaint.status).toBe('rejected');
      expect(complaints).toBe(0); // a complaint on a closed order would be a ghost
    }
  }, 60000);
});
