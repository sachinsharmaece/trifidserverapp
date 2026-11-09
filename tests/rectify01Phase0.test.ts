import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Buyer } from '../src/models/Buyer.js';
import { Config } from '../src/models/Config.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Enquiry } from '../src/models/Enquiry.js';
import { FailureEvent } from '../src/models/FailureEvent.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { Pile } from '../src/models/Pile.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { Pool } from '../src/models/Pool.js';
import { PoolCommitment } from '../src/models/PoolCommitment.js';
import { Product } from '../src/models/Product.js';
import { Quote } from '../src/models/Quote.js';
import { RateChangeRequest } from '../src/models/RateChangeRequest.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { So } from '../src/models/So.js';
import { StaffNotice } from '../src/models/StaffNotice.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import { giveRateOnAsk } from '../src/modules/desk/sales/sales.stageActions.js';
import {
  createListing,
  createPileRequest,
  computeBuyerFacingRatePaise,
  getBuyerFeed,
  getMyListings,
  getProductOffers,
  pauseListing,
  relistListing,
} from '../src/modules/listing/listing.service.js';
import { commitToPool } from '../src/modules/pool/pool.service.js';
import {
  REPORT_COLUMNS,
  SELLER_REQUOTES,
  applyRestart,
  applyStop,
  parseScope,
  planRestart,
  planStop,
} from '../src/modules/marketplace/marketplace.bulk.js';
import { runAudit } from '../src/modules/marketplace/marketplace.audit.js';
import { requestRateChange } from '../src/modules/desk/sales/sales.rateChange.js';
import { assertDatabaseAllowed, toCsv } from '../src/shared/scriptSupport.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { purchaseLeader } from './buyerHelpers.js';
import { acceptOffer } from './pileOfferHelpers.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * RECTIFY-01 Phase 0 — staff stop trading at once. Stop and restart a listing, withdraw a quote, the
 * emergency scripts, and the `marketplace_paused` brake (RECTIFY-01_BUILD §1.5, tests 1 to 11; test 12,
 * "existing tests pass with the flags off", is the rest of the suite).
 */

const app = createApp();
const SELLER_NET = 40000; // What the seller quotes.
const LISTING_NET = 45000; // What his own listing asks, so a quote publishes a line of its own.
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => randomUUID();

type Staff = { token: string; employeeId: string };
let admin: Staff;
let purchaseExec: Staff; // A Purchase person with no leader position: has neither new permission.
let leader: Staff; // Purchase Leader.
let sales: Staff;

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  purchaseExec = await staffToken(app, 'purchase');
  sales = await staffToken(app, 'sales');
  leader = await purchaseLeader(app);
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
}, 60000);

interface World {
  tehsil: string;
  skuId: string;
  productId: string;
  sellerDocId: string;
  sellerCp: string;
  sellerFirm: string;
  listingId: string;
  lineId: string;
  buyers: Array<{ docId: string; cp: string; firm: string }>;
}

async function firmOf(counterpartyId: string): Promise<string> {
  return (await Counterparty.findById(counterpartyId))!.firm!;
}

/** A seller with a live 30-box listing, and `buyerCount` approved buyers in the same tehsil. */
async function world(buyerCount = 2): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  const productId = String((await Sku.findById(skuId))!.productId);
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchaseExec.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyers: World['buyers'] = [];
  for (let i = 0; i < buyerCount; i += 1) {
    const docId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
    const cp = String((await Buyer.findById(docId))!.counterpartyId);
    buyers.push({ docId, cp, firm: await firmOf(cp) });
  }
  const created = await createListing(sellerCp, {
    productId,
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise: LISTING_NET,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '48h',
        provenance: 'company',
        qty: 30,
      },
    ],
  } as never);
  return {
    tehsil,
    skuId,
    productId,
    sellerDocId,
    sellerCp,
    sellerFirm: await firmOf(sellerCp),
    listingId: created.listingId,
    lineId: created.lineIds[0]!,
    buyers,
  };
}

const stop = (token: string, listingId: string, body: Record<string, unknown>, key = idem()) =>
  request(app)
    .post(`/api/v1/staff/listings/${listingId}/stop`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
const restart = (
  token: string,
  listingId: string,
  body: Record<string, unknown> = {},
  key = idem(),
) =>
  request(app)
    .post(`/api/v1/staff/listings/${listingId}/restart`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
const withdraw = (token: string, quoteId: string, body: Record<string, unknown>, key = idem()) =>
  request(app)
    .post(`/api/v1/staff/quotes/${quoteId}/withdraw`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);

const REASON = { reasonCode: 'maintenance', note: 'Stock count at the hub.' };
const CONFIRM = { ...REASON, confirm: true };

async function listingRow(listingId: string) {
  return (await Listing.findById(listingId))!;
}
async function auditCount(entity: string, entityId: string): Promise<number> {
  return AuditLog.countDocuments({ entity, entityId });
}

const quoteInput = (overrides: Record<string, unknown> = {}) => ({
  ratePaiseForIndore: SELLER_NET,
  qtyAvailable: 10,
  expiryBand: 'over12' as const,
  expiryExact: '12/2099',
  deliveryBand: '48h' as const,
  provenance: 'company' as const,
  daysToIndore: 2,
  ...overrides,
});

type TrustTier = 'New' | 'Verified' | 'Trusted' | 'Committed';

/**
 * Sellers who list the same pack on the same terms at a 50-box MOQ share one pool (BR-151). The lowest
 * rate among sellers above tier `New` supplies it (BR-152/BR-153), so `rates` says who that is.
 */
async function poolWorld(rates: number[] = [SELLER_NET], tier: TrustTier = 'Trusted') {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  const productId = String((await Sku.findById(skuId))!.productId);
  const sellers: Array<{ sellerDocId: string; sellerCp: string; listingId: string }> = [];
  for (const ratePaise of rates) {
    const sellerDocId = await createApprovedSellerAtTehsils(app, purchaseExec.token, [tehsil]);
    await Seller.updateOne({ _id: sellerDocId }, { $set: { trustTier: tier } });
    const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
    const created = await createListing(sellerCp, {
      productId,
      scopeType: 'my_area',
      lines: [
        {
          skuId,
          ratePaise,
          expiryBand: 'over12',
          moqExact: 50, // Any MOQ above 1 opens a pool.
          deliveryBand: '48h',
          provenance: 'company',
          qty: 100,
        },
      ],
    } as never);
    sellers.push({ sellerDocId, sellerCp, listingId: created.listingId });
  }
  const buyerDocId = await createApprovedBuyerAtTehsil(app, sales.token, tehsil, 'dealer');
  const buyerCp = String((await Buyer.findById(buyerDocId))!.counterpartyId);
  const pool = (await Pool.findOne({ skuId, isActive: true }))!;
  return { skuId, productId, sellers, buyerDocId, buyerCp, poolId: String(pool._id) };
}

/** One buyer committed to the pool, paid or not. */
async function commitToPoolDirect(w: { poolId: string; buyerDocId: string }, paid: boolean) {
  await PoolCommitment.create({
    poolId: w.poolId,
    buyerId: w.buyerDocId,
    qty: 20,
    ...(paid ? { paidAt: new Date(), isBinding: true } : {}),
  });
}

/** A live rate on a fresh ask for 10 boxes: the seller quoted it parked, Sales gave it. */
async function liveQuote(w: World, buyerIndex = 0, sellerCp = w.sellerCp, overrides = {}) {
  const { askId } = await demandService.raiseAsk(w.buyers[buyerIndex]!.cp, {
    skuId: w.skuId,
    allPacks: false,
    qty: 10,
    conditionRequirement: { expiryBand: 'over12' },
  });
  const { quoteId } = await demandService.postQuote(sellerCp, askId, quoteInput(overrides), {
    holdForSales: true,
  });
  await demandService.releaseQuote(quoteId);
  return { askId, quoteId };
}

describe('1. stop with confirm absent shows the impact and writes nothing', () => {
  it('returns the preview', async () => {
    const w = await world();
    await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 10 });
    await createPileRequest(w.buyers[1]!.cp, w.lineId, { qty: 5 });
    const before = await auditCount('listing', w.listingId);

    const res = await stop(leader.token, w.listingId, REASON);

    expect(res.status).toBe(200);
    expect(res.body.data.confirmed).toBe(false);
    const { preview } = res.body.data;
    expect(preview.alreadyStopped).toBe(false);
    expect(preview.boxesInStock).toBe(30);
    expect(preview.lines).toHaveLength(1);
    expect(preview.piles).toEqual({ open: 1, boxesPiled: 15, buyers: 2 });
    expect(preview.quotes).toEqual({ parked: 0, live: 0 });
    expect(preview.pools.open).toBe(0);

    // Nothing was written.
    const listing = await listingRow(w.listingId);
    expect(listing.state).toBe('live');
    expect(listing.stoppedBy ?? null).toBeNull();
    expect(await Pile.countDocuments({ listingLineId: w.lineId, decision: null })).toBe(1);
    expect(await auditCount('listing', w.listingId)).toBe(before);
  });

  it('refuses a missing note or reason in plain words', async () => {
    const w = await world(1);
    const noNote = await stop(leader.token, w.listingId, { reasonCode: 'maintenance', note: '  ' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.field).toBe('note');
    expect(noNote.body.error.message_en).toBe('Say why, in a few words.');
    const noReason = await stop(leader.token, w.listingId, { note: 'x' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.field).toBe('reasonCode');
    expect((await listingRow(w.listingId)).state).toBe('live');
  });
});

describe('2. stop pauses the listing; the buyer can no longer see or request it', () => {
  it('sets paused and the staff fields, leaves the feed, and refuses a new pile request', async () => {
    const w = await world(1);
    const buyer = w.buyers[0]!;
    const offersBefore = await getProductOffers(buyer.cp, w.productId);
    expect(offersBefore.offers.map((o) => o.listingLineId)).toContain(w.lineId);
    expect((await getBuyerFeed(buyer.cp, 0, 50)).items.map((c) => c.productId)).toContain(
      w.productId,
    );

    const res = await stop(leader.token, w.listingId, CONFIRM);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: true, stopped: true });
    const listing = await listingRow(w.listingId);
    expect(listing.state).toBe('paused');
    expect(listing.pausedAt).toBeTruthy();
    expect(listing.stoppedBy).toBe('staff');
    expect(String(listing.stoppedByEmployeeId)).toBe(leader.employeeId);
    expect(listing.stopReasonCode).toBe('maintenance');
    expect(listing.stopNote).toBe(REASON.note);
    expect(await auditCount('listing', w.listingId)).toBeGreaterThan(0);

    const offersAfter = await getProductOffers(buyer.cp, w.productId);
    expect(offersAfter.offers.map((o) => o.listingLineId)).not.toContain(w.lineId);
    expect((await getBuyerFeed(buyer.cp, 0, 50)).items.map((c) => c.productId)).not.toContain(
      w.productId,
    );
    await expect(createPileRequest(buyer.cp, w.lineId, { qty: 2 })).rejects.toMatchObject({
      code: 'NOT_VISIBLE',
    });
  });
});

describe('3. the seller cannot undo it; only restart lifts it', () => {
  it("refuses the seller's relist, and restart lifts it with a fresh 45 days", async () => {
    const w = await world(1);
    const open = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 4 });
    await stop(leader.token, w.listingId, CONFIRM);

    await expect(relistListing(w.sellerCp, w.listingId)).rejects.toMatchObject({
      messageEn: 'TriFid has paused this listing. Call the purchase desk.',
    });
    expect((await listingRow(w.listingId)).state).toBe('paused');

    const res = await restart(leader.token, w.listingId, { note: 'Count done.' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ restarted: true, alreadyLive: false });
    const listing = await listingRow(w.listingId);
    expect(listing.state).toBe('live');
    expect(listing.pausedAt ?? null).toBeNull();
    expect(listing.stoppedBy ?? null).toBeNull();
    expect(listing.stopReasonCode ?? null).toBeNull();
    const days = (listing.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(44);
    expect(days).toBeLessThanOrEqual(45);

    // The group the stop closed as a desk decline does not keep the restarted line shut.
    const again = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 2 });
    expect(again.pileId).not.toBe(open.pileId);
  });

  it('is not the staff to restart a listing the seller paused himself', async () => {
    const w = await world(1);
    await pauseListing(w.sellerCp, w.listingId);
    const res = await restart(leader.token, w.listingId);
    expect(res.status).toBe(400);
    expect(res.body.error.message_en).toMatch(/seller paused it/);
    await relistListing(w.sellerCp, w.listingId); // His own relist still works.
    expect((await listingRow(w.listingId)).state).toBe('live');
  });

  it('a staff stop on a listing the seller had paused takes it out of his hands', async () => {
    const w = await world(1);
    await pauseListing(w.sellerCp, w.listingId);
    const res = await stop(leader.token, w.listingId, CONFIRM);
    expect(res.body.data.stopped).toBe(true);
    await expect(relistListing(w.sellerCp, w.listingId)).rejects.toMatchObject({
      messageEn: 'TriFid has paused this listing. Call the purchase desk.',
    });
  });
});

describe('4. open piles are declined with no strike, no buyer message, and Sales is told', () => {
  it('declines the pile, tells Sales who to call, and tells nobody else', async () => {
    const w = await world(2);
    const [a, b] = w.buyers as [World['buyers'][number], World['buyers'][number]];
    const first = await createPileRequest(a.cp, w.lineId, { qty: 10 });
    await createPileRequest(b.cp, w.lineId, { qty: 5 });
    const requests = await PileRequest.find({ pileId: first.pileId });
    const outboxBefore = await NotificationOutbox.countDocuments({
      counterpartyId: { $in: [a.cp, b.cp, w.sellerCp] },
    });
    const failuresBefore = await FailureEvent.countDocuments({});
    const noticesBefore = (await StaffNotice.find({}, { _id: 1 })).map((n) => n._id);

    const res = await stop(leader.token, w.listingId, CONFIRM);
    expect(res.body.data).toMatchObject({ stopped: true, pilesClosed: 1 });

    const pile = (await Pile.findById(first.pileId))!;
    expect(pile.decision).toBe('declined');
    expect(pile.deskDeclined).toBe(true);
    // The enquiries show it.
    const enquiries = await Enquiry.find({ pileRequestId: { $in: requests.map((r) => r._id) } });
    expect(enquiries).toHaveLength(2);
    expect(enquiries.every((e) => e.status === 'declined')).toBe(true);
    // No strike; nobody was messaged.
    expect(await FailureEvent.countDocuments({})).toBe(failuresBefore);
    expect(
      await NotificationOutbox.countDocuments({
        counterpartyId: { $in: [a.cp, b.cp, w.sellerCp] },
      }),
    ).toBe(outboxBefore);

    // Sales is told which buyers to call: by name, with their boxes, and never the seller.
    const owners = new Set<string>();
    for (const buyer of [a, b]) {
      const book = await BookAssignment.findOne({ buyerId: buyer.docId });
      owners.add(String(book!.ownerEmployeeId));
    }
    const notices = await StaffNotice.find({
      employeeId: { $in: [...owners] },
      kind: 'listing_stopped',
    });
    expect(notices.length).toBeGreaterThan(0);
    const text = notices.map((n) => `${n.title} ${n.body}`).join(' ');
    expect(text).toContain(a.firm);
    expect(text).toContain(b.firm);
    expect(text).toContain('10 boxes');
    expect(text).not.toContain(w.sellerFirm);

    // And nobody else: every notice this stop raised went to a buyer's Sales owner — not to his
    // Sales Leader, not to Purchase, not to the Admins, not to any other Sales person.
    const expected = new Set(owners);
    const raised = await StaffNotice.find({ _id: { $nin: noticesBefore } });
    expect(raised.length).toBeGreaterThan(0);
    for (const notice of raised) expect(expected.has(String(notice.employeeId))).toBe(true);
    expect(expected.has(leader.employeeId)).toBe(false); // The Purchase Leader who pressed Stop.
    expect(expected.has(purchaseExec.employeeId)).toBe(false);
  });
});

describe('5. a deal already offered and an order already raised survive the stop', () => {
  it('lets an offered deal be taken inside its 24 hours, and leaves the raised order alone', async () => {
    const w = await world(3);
    const [a, b, c] = w.buyers as [
      World['buyers'][number],
      World['buyers'][number],
      World['buyers'][number],
    ];
    await createPileRequest(a.cp, w.lineId, { qty: 10 });
    const { pileId } = await createPileRequest(b.cp, w.lineId, { qty: 5 });
    await demandService.confirmPile(
      w.sellerCp,
      pileId,
      { canSendBoxes: 15, expiryExact: '2029' },
      randomUUID(),
    );
    await runConfirmPileFanout(pileId);
    const [dealA, dealB] = await PileRequest.find({ pileId }).sort({ requestedAt: 1 });
    expect(dealA!.offerState).toBe('offered');

    // A takes his deal: an order exists. A new buyer then piles on the line: an open group.
    const { soId } = await acceptOffer(String(dealA!._id), dealA!.buyerId);
    const orderBefore = (await So.findById(soId))!;
    const fresh = await createPileRequest(c.cp, w.lineId, { qty: 3 });

    const res = await stop(leader.token, w.listingId, CONFIRM);
    expect(res.body.data).toMatchObject({ stopped: true, pilesClosed: 1 });
    expect(res.body.data.preview.offeredDealsRunning.count).toBe(1);

    expect((await Pile.findById(fresh.pileId))!.decision).toBe('declined');
    // B's deal is still on, and the order already raised is exactly as it was.
    expect((await PileRequest.findById(dealB!._id))!.offerState).toBe('offered');
    const orderAfter = (await So.findById(soId))!;
    expect(orderAfter.state).toBe(orderBefore.state);
    expect(orderAfter.totalPaise).toBe(orderBefore.totalPaise);

    const taken = await acceptOffer(String(dealB!._id), dealB!.buyerId);
    expect((await So.findById(taken.soId))!.state).toBe('awaiting_payment');
    expect((await PileRequest.findById(dealB!._id))!.offerState).toBe('ordered');
  });
});

describe('6. withdrawing a live quote', () => {
  it('returns the ask to open, clears the hold, lapses its rate change, and tells Sales to call', async () => {
    const w = await world(1);
    const { askId, quoteId } = await liveQuote(w);
    const quote = (await Quote.findById(quoteId))!;
    const ask = (await Ask.findById(askId))!;
    expect(ask.state).toBe('quoted');
    expect(ask.holdExpiresAt).toBeTruthy();
    const buyer = (await Buyer.findById(w.buyers[0]!.docId))!;
    const shown = (await computeBuyerFacingRatePaise(buyer, w.skuId, quote.ratePaiseForIndore))!;
    const { requestId } = await requestRateChange(
      quoteId,
      { boxes: 5, ratePaise: shown },
      { employeeId: sales.employeeId, correlationId: 'test' },
      'He wants five.',
    );
    const failuresBefore = await FailureEvent.countDocuments({});
    const outboxBefore = await NotificationOutbox.countDocuments({
      counterpartyId: w.buyers[0]!.cp,
    });

    const res = await withdraw(leader.token, quoteId, CONFIRM);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: true, withdrawn: true });
    const after = (await Quote.findById(quoteId))!;
    expect(after.status).toBe('withdrawn');
    expect(after.withdrawnAt).toBeTruthy();
    expect(String(after.withdrawnBy)).toBe(leader.employeeId);
    expect(after.withdrawReasonCode).toBe('maintenance');
    expect(after.rank ?? null).toBeNull(); // No rank.
    const askAfter = (await Ask.findById(askId))!;
    expect(askAfter.state).toBe('open');
    expect(askAfter.holdExpiresAt ?? null).toBeNull();
    expect((await RateChangeRequest.findById(requestId))!.status).toBe('lapsed');
    // Sales is told to call; the buyer is not messaged; there is no strike.
    expect(await FailureEvent.countDocuments({})).toBe(failuresBefore);
    expect(await NotificationOutbox.countDocuments({ counterpartyId: w.buyers[0]!.cp })).toBe(
      outboxBefore,
    );
    const book = await BookAssignment.findOne({ buyerId: w.buyers[0]!.docId });
    const told = await StaffNotice.find({
      employeeId: book!.ownerEmployeeId,
      kind: 'rate_withdrawn',
    });
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toBe(
      `A rate given to ${w.buyers[0]!.firm} has been withdrawn. Call him.`,
    );
    // The enquiry follows the ask back.
    expect((await Enquiry.findOne({ askId }))!.status).not.toBe('quotes_received');
  });

  it('leaves the ask quoted when another live quote remains', async () => {
    const w = await world(1);
    const otherSellerDoc = await createApprovedSellerAtTehsils(app, purchaseExec.token, [w.tehsil]);
    const otherSellerCp = String((await Seller.findById(otherSellerDoc))!.counterpartyId);
    const { askId, quoteId } = await liveQuote(w);
    const second = await demandService.postQuote(
      otherSellerCp,
      askId,
      quoteInput({ ratePaiseForIndore: SELLER_NET + 500 }),
      { holdForSales: true },
    );
    await demandService.releaseQuote(second.quoteId);
    const hold = (await Ask.findById(askId))!.holdExpiresAt;

    const res = await withdraw(leader.token, quoteId, CONFIRM);
    expect(res.body.data.withdrawn).toBe(true);
    const ask = (await Ask.findById(askId))!;
    expect(ask.state).toBe('quoted');
    expect(ask.holdExpiresAt!.getTime()).toBe(hold!.getTime());
    expect((await Quote.findById(second.quoteId))!.status).toBe('live');
  });

  it('shows the preview first, and a parked quote leaves the ask alone', async () => {
    const w = await world(1);
    const { askId } = await demandService.raiseAsk(w.buyers[0]!.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty: 10,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const { quoteId } = await demandService.postQuote(w.sellerCp, askId, quoteInput(), {
      holdForSales: true,
    });
    const preview = await withdraw(leader.token, quoteId, REASON);
    expect(preview.body.data.confirmed).toBe(false);
    expect(preview.body.data.preview.willHappen).toMatchObject({
      salesToldToCall: false,
      linePaused: true,
    });
    expect((await Quote.findById(quoteId))!.status).toBe('pending_sales');

    await withdraw(leader.token, quoteId, CONFIRM);
    expect((await Quote.findById(quoteId))!.status).toBe('withdrawn');
    expect((await Ask.findById(askId))!.state).toBe('open');
    expect(
      await StaffNotice.countDocuments({
        kind: 'rate_withdrawn',
        body: new RegExp(w.buyers[0]!.firm),
      }),
    ).toBe(0);
  });

  it('refuses a quote that has already closed', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    await Quote.updateOne({ _id: quoteId }, { $set: { status: 'won' } });
    const res = await withdraw(leader.token, quoteId, CONFIRM);
    expect(res.status).toBe(400);
    expect(res.body.error.message_en).toMatch(/already closed/);
  });
});

describe("7. a quote's own line is paused with it; the seller's own line is left alone", () => {
  it('pauses the quote-born listing when no other open quote points at it', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    const quote = (await Quote.findById(quoteId))!;
    const line = (await ListingLine.findById(quote.listingLineId))!;
    const born = await Listing.findById(line.listingId);
    expect(born!.origin).toBe('quote_born');
    expect(born!.state).toBe('live');

    const res = await withdraw(leader.token, quoteId, CONFIRM);
    expect(res.body.data.linePaused).toBe(true);
    const after = (await Listing.findById(line.listingId))!;
    expect(after.state).toBe('paused');
    expect(after.stoppedBy).toBe('staff');
    // The seller cannot put it back.
    await expect(relistListing(w.sellerCp, String(after._id))).rejects.toMatchObject({
      messageEn: 'TriFid has paused this listing. Call the purchase desk.',
    });
  });

  it("leaves the line alone when the quote reused the seller's own earlier line", async () => {
    const w = await world(1);
    // The seller's own listing is already on the board at exactly the quote's terms.
    await Listing.updateOne({ _id: w.listingId }, { $set: { origin: 'seller_initiated' } });
    await ListingLine.updateOne(
      { _id: w.lineId },
      { $set: { expiryExact: '12/2099', ratePaise: SELLER_NET } },
    );
    const { quoteId } = await liveQuote(w);
    const quote = (await Quote.findById(quoteId))!;
    expect(String(quote.listingLineId)).toBe(w.lineId); // It reused his line.

    const res = await withdraw(leader.token, quoteId, CONFIRM);
    expect(res.body.data).toMatchObject({ withdrawn: true, linePaused: false });
    expect((await listingRow(w.listingId)).state).toBe('live');
  });

  it('does not pause the line while another open quote still points at it', async () => {
    const w = await world(2);
    const first = await liveQuote(w, 0);
    const line = String((await Quote.findById(first.quoteId))!.listingLineId);
    // A second ask quoted by the same seller at identical terms reuses the same published line.
    const second = await liveQuote(w, 1);
    expect(String((await Quote.findById(second.quoteId))!.listingLineId)).toBe(line);

    const res = await withdraw(leader.token, first.quoteId, CONFIRM);
    expect(res.body.data.linePaused).toBe(false);
    const listingOfLine = (await ListingLine.findById(line))!.listingId;
    expect((await Listing.findById(listingOfLine))!.state).toBe('live');
  });
});

describe("7b. withdrawing a quote closes the buyers' open piles on its line, as a stop does", () => {
  async function bornLine(w: World, buyerIndex = 0) {
    const { quoteId } = await liveQuote(w, buyerIndex);
    const quote = (await Quote.findById(quoteId))!;
    const line = (await ListingLine.findById(quote.listingLineId))!;
    return { quoteId, lineId: String(line._id), listingId: String(line.listingId) };
  }

  it('declines the open piles, tells Sales whom to ring, and nobody can then confirm one', async () => {
    const w = await world(2);
    const born = await bornLine(w, 0);
    const pile = await createPileRequest(w.buyers[1]!.cp, born.lineId, { qty: 4 });
    const noticesBefore = (await StaffNotice.find({}, { _id: 1 })).map((n) => n._id);
    const failuresBefore = await FailureEvent.countDocuments({});

    // The preview says so before anything is written.
    const preview = await withdraw(leader.token, born.quoteId, REASON);
    expect(preview.body.data.preview.willHappen).toMatchObject({
      linePaused: true,
      pilesDeclined: 1,
    });
    expect((await Pile.findById(pile.pileId))!.decision ?? null).toBeNull();

    const res = await withdraw(leader.token, born.quoteId, CONFIRM);
    expect(res.body.data).toMatchObject({ withdrawn: true, linePaused: true, pilesClosed: 1 });
    expect((await listingRow(born.listingId)).state).toBe('paused');
    expect(await Pile.findById(pile.pileId)).toMatchObject({
      decision: 'declined',
      deskDeclined: true,
    });
    const requests = await PileRequest.find({ pileId: pile.pileId });
    const enquiries = await Enquiry.find({ pileRequestId: { $in: requests.map((r) => r._id) } });
    expect(enquiries).toHaveLength(1);
    expect(enquiries.every((e) => e.status === 'declined')).toBe(true);
    expect(await FailureEvent.countDocuments({})).toBe(failuresBefore); // No strike.

    // Sales is told whom to ring: the buyer by name with his boxes, never the seller.
    const raised = await StaffNotice.find({
      _id: { $nin: noticesBefore },
      kind: 'listing_stopped',
    });
    const text = raised.map((n) => `${n.title} ${n.body}`).join(' ');
    expect(text).toContain(w.buyers[1]!.firm);
    expect(text).toContain('4 boxes');
    expect(text).not.toContain(w.sellerFirm);

    // The seller cannot confirm it, and the fan-out gives nobody a deal at the withdrawn rate.
    await expect(
      demandService.confirmPile(
        w.sellerCp,
        pile.pileId,
        { canSendBoxes: 4, expiryExact: '2029' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PILE_ALREADY_DECIDED' });
    await runConfirmPileFanout(pile.pileId);
    expect(await PileRequest.countDocuments({ pileId: pile.pileId, offerState: 'offered' })).toBe(
      0,
    );
  });

  it("leaves the piles open when the line stays live (the seller's own line the quote reused)", async () => {
    const w = await world(2);
    await Listing.updateOne({ _id: w.listingId }, { $set: { origin: 'seller_initiated' } });
    await ListingLine.updateOne(
      { _id: w.lineId },
      { $set: { expiryExact: '12/2099', ratePaise: SELLER_NET } },
    );
    const { quoteId } = await liveQuote(w, 0);
    expect(String((await Quote.findById(quoteId))!.listingLineId)).toBe(w.lineId);
    const pile = await createPileRequest(w.buyers[1]!.cp, w.lineId, { qty: 3 });

    const res = await withdraw(leader.token, quoteId, CONFIRM);
    expect(res.body.data).toMatchObject({ withdrawn: true, linePaused: false, pilesClosed: 0 });
    expect((await Pile.findById(pile.pileId))!.decision ?? null).toBeNull();
  });
});

describe('7c. a listing TriFid stopped confirms nothing', () => {
  const confirmInput = { canSendBoxes: 4, expiryExact: '2029' };

  it('refuses the seller and Purchase on a call, with the brake off', async () => {
    const w = await world(1);
    const { pileId } = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 4 });
    // A group left open on a stopped listing: the state a quote withdrawal used to leave behind.
    await Listing.updateOne(
      { _id: w.listingId },
      { $set: { state: 'paused', stoppedBy: 'staff' } },
    );
    await expect(
      demandService.confirmPile(w.sellerCp, pileId, confirmInput, randomUUID()),
    ).rejects.toMatchObject({
      messageEn: 'TriFid has paused this listing. Call the purchase desk.',
    });

    const onTheCall = await request(app)
      .post(`/api/v1/staff/proxy/seller/confirmations/${pileId}/confirm`)
      .set(auth(purchaseExec.token))
      .set('Idempotency-Key', idem())
      .send({ sellerCounterpartyId: w.sellerCp, canSendBoxes: 4 });
    expect(onTheCall.status).toBe(400);
    expect(onTheCall.body.error.message_en).toMatch(/TriFid has paused this listing/);
    expect((await Pile.findById(pileId))!.decision ?? null).toBeNull();
  });

  it('does not overwrite a decline that lands while the confirm is running', async () => {
    const w = await world(1);
    const { pileId } = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 4 });
    // The stop's decline arrives between the confirm reading the pile and writing its decision.
    const original = PileRequest.find.bind(PileRequest) as (...args: unknown[]) => unknown;
    const spy = vi
      .spyOn(PileRequest, 'find')
      .mockImplementationOnce(((...args: unknown[]) =>
        Pile.updateOne(
          { _id: pileId },
          { $set: { decision: 'declined', deskDeclined: true, decidedAt: new Date() } },
        ).then(() => original(...args))) as never);
    try {
      await expect(
        demandService.confirmPile(w.sellerCp, pileId, confirmInput, randomUUID()),
      ).rejects.toMatchObject({ code: 'PILE_ALREADY_DECIDED' });
    } finally {
      spy.mockRestore();
    }
    const pile = (await Pile.findById(pileId))!;
    expect(pile).toMatchObject({ decision: 'declined', deskDeclined: true });
    expect(pile.confirmedQty ?? null).toBeNull();
    expect(pile.sellerLockedUntil ?? null).toBeNull();
  });
});

describe('7d. a pile confirmed but not yet offered when the listing is stopped', () => {
  it('is closed by the fan-out as a desk decline, and nobody is given a deal', async () => {
    const w = await world(2);
    const [a, b] = w.buyers as [World['buyers'][number], World['buyers'][number]];
    const { pileId } = await createPileRequest(a.cp, w.lineId, { qty: 5 });
    await createPileRequest(b.cp, w.lineId, { qty: 3 });
    await demandService.confirmPile(
      w.sellerCp,
      pileId,
      { canSendBoxes: 8, expiryExact: '2029' },
      randomUUID(),
    );
    const preview = await stop(leader.token, w.listingId, REASON);
    expect(preview.body.data.preview.pilesConfirmingNotOffered).toBe(1);

    const res = await stop(leader.token, w.listingId, CONFIRM);
    expect(res.body.data.stopped).toBe(true);
    // The stop leaves the confirmed pile to the fan-out, which is what would have given the deals.
    expect((await Pile.findById(pileId))!.decision).toBe('confirmed');

    const failuresBefore = await FailureEvent.countDocuments({});
    const outboxBefore = await NotificationOutbox.countDocuments({
      counterpartyId: { $in: [a.cp, b.cp, w.sellerCp] },
    });
    const noticesBefore = (await StaffNotice.find({}, { _id: 1 })).map((n) => n._id);
    await runConfirmPileFanout(pileId);

    const pile = (await Pile.findById(pileId))!;
    expect(pile).toMatchObject({ decision: 'declined', deskDeclined: true });
    expect(pile.executedAt ?? null).toBeNull();
    expect(await PileRequest.countDocuments({ pileId, offerState: 'offered' })).toBe(0);
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(30); // No boxes were held back.
    const requests = await PileRequest.find({ pileId });
    const enquiries = await Enquiry.find({ pileRequestId: { $in: requests.map((r) => r._id) } });
    expect(enquiries).toHaveLength(2);
    expect(enquiries.every((e) => e.status === 'declined')).toBe(true);
    expect(await FailureEvent.countDocuments({})).toBe(failuresBefore);
    expect(
      await NotificationOutbox.countDocuments({
        counterpartyId: { $in: [a.cp, b.cp, w.sellerCp] },
      }),
    ).toBe(outboxBefore);
    const raised = await StaffNotice.find({
      _id: { $nin: noticesBefore },
      kind: 'listing_stopped',
    });
    const text = raised.map((n) => `${n.title} ${n.body}`).join(' ');
    expect(text).toContain(a.firm);
    expect(text).toContain(b.firm);
    expect(text).not.toContain(w.sellerFirm);

    // A second run finds nothing to do.
    const settled = await StaffNotice.countDocuments({});
    await runConfirmPileFanout(pileId);
    expect(await StaffNotice.countDocuments({})).toBe(settled);
  });

  it('still gives the deals if the listing was restarted before the fan-out ran', async () => {
    const w = await world(1);
    const { pileId } = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 5 });
    await demandService.confirmPile(
      w.sellerCp,
      pileId,
      { canSendBoxes: 5, expiryExact: '2029' },
      randomUUID(),
    );
    await stop(leader.token, w.listingId, CONFIRM);
    await restart(leader.token, w.listingId);
    await runConfirmPileFanout(pileId);
    expect(await PileRequest.countDocuments({ pileId, offerState: 'offered' })).toBe(1);
    expect((await Pile.findById(pileId))!.decision).toBe('confirmed');
  });
});

describe('3b. a restart does not revive a line with no quote behind it', () => {
  async function bornListingOf(quoteId: string): Promise<string> {
    const quote = (await Quote.findById(quoteId))!;
    return String((await ListingLine.findById(quote.listingLineId))!.listingId);
  }

  it('skips a quote-born line whose quote was withdrawn, and reports "seller re-quotes"', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    const bornId = await bornListingOf(quoteId);
    await withdraw(leader.token, quoteId, CONFIRM);
    expect((await listingRow(bornId)).state).toBe('paused');

    const res = await restart(leader.token, bornId, { note: 'Try.' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      restarted: false,
      alreadyLive: false,
      skipped: 'seller re-quotes',
    });
    const still = await listingRow(bornId);
    expect(still.state).toBe('paused');
    expect(still.stoppedBy).toBe('staff');
  });

  it('restarts a quote-born line while an open quote still points at it', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    const bornId = await bornListingOf(quoteId);
    // Paused by staff without touching the quote: the rule is about the quote, not how it got there.
    await Listing.updateOne({ _id: bornId }, { $set: { state: 'paused', stoppedBy: 'staff' } });
    const res = await restart(leader.token, bornId);
    expect(res.status).toBe(200);
    expect(res.body.data.restarted).toBe(true);
    expect((await Quote.findById(quoteId))!.status).toBe('live');
  });

  it('leaves such a line stopped in a batch restart, and says "seller re-quotes"', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    const bornId = await bornListingOf(quoteId);
    const plan = await planStop(parseScope(`seller=${w.sellerDocId}`));
    const run = await applyStop(plan, {
      reasonCode: 'maintenance',
      note: 'x',
      employeeId: admin.employeeId,
    });
    expect((await Quote.findById(quoteId))!.status).toBe('withdrawn');
    expect((await listingRow(bornId)).stopBatchId).toBe(run.stopBatchId);

    const rows = await applyRestart(run.stopBatchId, {
      employeeId: admin.employeeId,
      correlationId: 'test-restart',
    });
    const outcomes = new Map(rows.map((row) => [row.listingId, row.outcome]));
    expect(outcomes.get(w.listingId)).toBe('restarted');
    expect(outcomes.get(bornId)).toBe(SELLER_REQUOTES);
    expect((await listingRow(w.listingId)).state).toBe('live');
    expect((await listingRow(bornId)).state).toBe('paused');
  });
});

describe('8. a second call changes nothing; the permission is required', () => {
  it('stop is idempotent, by key and by state', async () => {
    const w = await world(1);
    await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 3 });
    const key = idem();
    const first = await stop(leader.token, w.listingId, CONFIRM, key);
    expect(first.body.data.stopped).toBe(true);
    const audits = await AuditLog.countDocuments({});
    const notices = await StaffNotice.countDocuments({});

    // Same key: the answer is replayed.
    const replay = await stop(leader.token, w.listingId, CONFIRM, key);
    expect(replay.body).toEqual(first.body);
    // A fresh key: nothing to do, nothing written.
    const again = await stop(leader.token, w.listingId, CONFIRM);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ confirmed: true, stopped: false });
    expect(await AuditLog.countDocuments({})).toBe(audits);
    expect(await StaffNotice.countDocuments({})).toBe(notices);

    // Restart is idempotent the same way.
    expect((await restart(leader.token, w.listingId)).body.data.restarted).toBe(true);
    const restartAudits = await AuditLog.countDocuments({});
    const second = await restart(leader.token, w.listingId);
    expect(second.body.data).toEqual({ restarted: false, alreadyLive: true });
    expect(await AuditLog.countDocuments({})).toBe(restartAudits);
  });

  it('withdraw is idempotent, by key and by state', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    const key = idem();
    const first = await withdraw(leader.token, quoteId, CONFIRM, key);
    expect(first.body.data.withdrawn).toBe(true);
    const audits = await AuditLog.countDocuments({});
    const notices = await StaffNotice.countDocuments({});
    expect((await withdraw(leader.token, quoteId, CONFIRM, key)).body).toEqual(first.body);
    const again = await withdraw(leader.token, quoteId, CONFIRM);
    expect(again.body.data).toMatchObject({ confirmed: true, withdrawn: false });
    expect(await AuditLog.countDocuments({})).toBe(audits);
    expect(await StaffNotice.countDocuments({})).toBe(notices);
  });

  it('refuses a caller without the permission, and needs an Idempotency-Key', async () => {
    const w = await world(1);
    const { quoteId } = await liveQuote(w);
    for (const who of [purchaseExec, sales]) {
      expect((await stop(who.token, w.listingId, CONFIRM)).status).toBe(403);
      expect((await restart(who.token, w.listingId)).status).toBe(403);
      expect((await withdraw(who.token, quoteId, CONFIRM)).status).toBe(403);
    }
    const noKey = await request(app)
      .post(`/api/v1/staff/listings/${w.listingId}/stop`)
      .set(auth(leader.token))
      .send(CONFIRM);
    expect(noKey.status).toBe(400);
    expect((await listingRow(w.listingId)).state).toBe('live');
    // Admin holds both; the Purchase Leader holds both.
    expect((await stop(admin.token, w.listingId, REASON)).status).toBe(200);
  });
});

describe("open pools are not cascaded over (S3), and only the pool's supplier is held to it", () => {
  it('counts the pool its seller supplies, refuses a Purchase Leader, and asks Admin to confirm', async () => {
    const w = await poolWorld();
    await commitToPoolDirect(w, false);
    const listingId = w.sellers[0]!.listingId;
    const settlingBefore = await StaffNotice.countDocuments({ kind: 'pool_needs_settling' });

    const asLeader = await stop(leader.token, listingId, REASON);
    expect(asLeader.body.data.preview.pools).toMatchObject({
      open: 1,
      suppliedByThisSeller: 1,
      withCommitments: 1,
      withPaidCommitments: 0,
    });
    expect(asLeader.body.data.preview.pools.list[0]).toMatchObject({
      poolId: w.poolId,
      commitments: 1,
      paidCommitments: 0,
      boxesCommitted: 20,
      suppliedByThisSeller: true,
    });
    // The dialog is told before Confirm: the Leader's is blocked, Admin's needs one tick.
    expect(asLeader.body.data.preview.gate).toMatchObject({
      blocked: { code: 'admin_only' },
      needsConfirm: [],
    });
    const asAdmin = await stop(admin.token, listingId, REASON);
    expect(asAdmin.body.data.preview.gate).toEqual({
      blocked: null,
      needsConfirm: ['confirmPools'],
    });

    const refused = await stop(leader.token, listingId, CONFIRM);
    expect(refused.status).toBe(403);
    expect((await listingRow(listingId)).state).toBe('live');

    const needsConfirm = await stop(admin.token, listingId, CONFIRM);
    expect(needsConfirm.status).toBe(409);
    expect(needsConfirm.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(needsConfirm.body.error.field).toBe('confirmPools');
    expect((await listingRow(listingId)).state).toBe('live');

    const done = await stop(admin.token, listingId, { ...CONFIRM, confirmPools: true });
    expect(done.body.data.stopped).toBe(true);
    // The pool itself is not touched, and nobody is told to settle it: nothing was paid.
    expect(await Pool.findById(w.poolId)).toMatchObject({ isActive: true, status: 'open' });
    expect(await StaffNotice.countDocuments({ kind: 'pool_needs_settling' })).toBe(settlingBefore);
  });

  it('a paid commitment needs Admin and a second tick, and the Admins are told which pool to settle', async () => {
    const w = await poolWorld();
    await commitToPoolDirect(w, true);
    const listingId = w.sellers[0]!.listingId;

    const preview = await stop(admin.token, listingId, REASON);
    expect(preview.body.data.preview.pools).toMatchObject({
      suppliedByThisSeller: 1,
      withCommitments: 1,
      withPaidCommitments: 1,
    });
    expect(preview.body.data.preview.gate).toEqual({
      blocked: null,
      needsConfirm: ['confirmPools', 'confirmPaidPools'],
    });

    // A Purchase Leader is refused whatever he ticks.
    const asLeader = await stop(leader.token, listingId, {
      ...CONFIRM,
      confirmPools: true,
      confirmPaidPools: true,
    });
    expect(asLeader.status).toBe(403);
    // Admin with the first tick only is asked for the second.
    const oneTick = await stop(admin.token, listingId, { ...CONFIRM, confirmPools: true });
    expect(oneTick.status).toBe(409);
    expect(oneTick.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(oneTick.body.error.field).toBe('confirmPaidPools');
    expect((await listingRow(listingId)).state).toBe('live');

    const both = await stop(admin.token, listingId, {
      ...CONFIRM,
      confirmPools: true,
      confirmPaidPools: true,
    });
    expect(both.status).toBe(200);
    expect(both.body.data.stopped).toBe(true);
    expect((await listingRow(listingId)).state).toBe('paused');
    // The pool and the payment are exactly as they were.
    expect(await Pool.findById(w.poolId)).toMatchObject({ isActive: true, status: 'open' });
    expect((await PoolCommitment.findOne({ poolId: w.poolId }))!.paidAt).toBeTruthy();

    // The Admins are told which pool needs settling — by id, pack and boxes, naming no buyer.
    const notices = await StaffNotice.find({
      kind: 'pool_needs_settling',
      body: new RegExp(w.poolId),
    });
    expect(notices.map((n) => String(n.employeeId))).toContain(admin.employeeId);
    const text = notices.map((n) => `${n.title} ${n.body}`).join(' ');
    // By product and pack, with the boxes — never a buyer.
    const product = (await Product.findById(w.productId))!;
    const sku = (await Sku.findById(w.skuId))!;
    expect(text).toContain(`${product.brand} ${sku.packLabel}`);
    expect(text).toContain('20 boxes committed');
    expect(text).not.toContain(await firmOf(w.buyerCp));
  });

  it('does not hold up a seller who is not the supplier: the pool is listed, nothing more', async () => {
    const w = await poolWorld([SELLER_NET, SELLER_NET + 1000]); // The first supplies it.
    await commitToPoolDirect(w, true);
    const [supplier, other] = w.sellers as [(typeof w.sellers)[number], (typeof w.sellers)[number]];

    const preview = await stop(leader.token, other.listingId, REASON);
    expect(preview.body.data.preview.pools).toMatchObject({
      open: 1,
      suppliedByThisSeller: 0,
      withCommitments: 0,
      withPaidCommitments: 0,
    });
    expect(preview.body.data.preview.pools.list[0]).toMatchObject({
      poolId: w.poolId,
      paidCommitments: 1,
      suppliedByThisSeller: false,
    });
    expect(preview.body.data.preview.gate).toEqual({ blocked: null, needsConfirm: [] });
    const done = await stop(leader.token, other.listingId, CONFIRM);
    expect(done.status).toBe(200);
    expect(done.body.data.stopped).toBe(true);

    // The one who does supply it is still held to the rule.
    const refused = await stop(leader.token, supplier.listingId, CONFIRM);
    expect(refused.status).toBe(403);
    expect((await listingRow(supplier.listingId)).state).toBe('live');
  });

  it('a New-tier seller supplies no pool (BR-153), so no pool holds him up either', async () => {
    const w = await poolWorld([SELLER_NET], 'New');
    await commitToPoolDirect(w, true);
    const done = await stop(leader.token, w.sellers[0]!.listingId, CONFIRM);
    expect(done.status).toBe(200);
    expect(done.body.data.stopped).toBe(true);
  });
});

describe('9. the emergency scripts', () => {
  it('plans the same thing it then does, and the batch restart touches only its own listings', async () => {
    const a = await world(2);
    const b = await world(1);
    // Open demand on A, a live quote on B, a seller-paused listing, and one staff-stopped by hand.
    await createPileRequest(a.buyers[0]!.cp, a.lineId, { qty: 6 });
    const { quoteId } = await liveQuote(b);
    const bornListing = String(
      (await ListingLine.findById((await Quote.findById(quoteId))!.listingLineId))!.listingId,
    );
    const c = await world(1);
    await pauseListing(c.sellerCp, c.listingId); // Seller paused: never in a batch.
    const d = await world(1);
    await stop(leader.token, d.listingId, CONFIRM); // Stopped by hand, no batch.

    const scope = parseScope(`seller=${a.sellerDocId}`);
    const dry = await planStop(scope);
    // A dry run changed nothing.
    expect((await listingRow(a.listingId)).state).toBe('live');
    expect(dry.listingIds).toEqual([a.listingId]);

    const startedOne = new Date();
    const result = await applyStop(dry, {
      reasonCode: 'compliance',
      note: 'Licence check.',
      employeeId: admin.employeeId,
    });
    expect(result.listingsStopped).toBe(1);
    expect(result.failures).toBe(0);
    // What the plan said is what the database now shows — read from the database, not from the
    // report: exactly the listings the plan said to stop carry this batch, exactly the quotes it said
    // to withdraw were withdrawn in the run.
    expect(
      (await Listing.find({ stopBatchId: result.stopBatchId })).map((l) => String(l._id)).sort(),
    ).toEqual([...dry.listingIds].sort());
    expect(
      (await Quote.find({ status: 'withdrawn', withdrawnAt: { $gte: startedOne } }))
        .map((q) => String(q._id))
        .sort(),
    ).toEqual([...dry.quoteIds].sort());
    const stopped = (await listingRow(a.listingId))!;
    expect(stopped.state).toBe('paused');
    expect(stopped.stopBatchId).toBe(result.stopBatchId);
    expect(stopped.stoppedBy).toBe('staff');
    expect((await Pile.findOne({ listingLineId: a.lineId }))!.decision).toBe('declined');
    // B was out of scope.
    expect((await Quote.findById(quoteId))!.status).toBe('live');

    // Everything, as another batch: B's quote is withdrawn with its quote-born line.
    const all = await planStop(parseScope('all'));
    expect(all.rows.some((r) => r.type === 'quote' && r.id === quoteId)).toBe(true);
    expect(all.listingIds).not.toContain(a.listingId); // Already stopped, so no longer live.
    expect(all.listingIds).not.toContain(c.listingId);
    expect(all.listingIds).not.toContain(d.listingId);
    const startedTwo = new Date();
    const second = await applyStop(all, {
      reasonCode: 'maintenance',
      note: 'Everything.',
      employeeId: admin.employeeId,
      confirmPools: true, // The pool tests above left listings with pools someone is committed to.
    });
    expect((await Quote.findById(quoteId))!.status).toBe('withdrawn');
    expect((await listingRow(bornListing)).stopBatchId).toBe(second.stopBatchId);
    expect(
      second.rows
        .filter((r) => r.type === 'quote')
        .every((r) => /^withdrawn/.test(String(r.outcome))),
    ).toBe(true);
    // Again from the database. Every listing the plan said to stop carries the batch; the only others
    // that do are lines born for the quotes it withdrew; every one it said to skip is still live.
    const inBatch = await Listing.find({ stopBatchId: second.stopBatchId });
    const inBatchIds = new Set(inBatch.map((l) => String(l._id)));
    for (const listingId of all.listingIds) expect(inBatchIds.has(listingId)).toBe(true);
    for (const l of inBatch) {
      if (!all.listingIds.includes(String(l._id))) expect(l.origin).toBe('quote_born');
    }
    const skippedRows = all.rows.filter((r) => r.type === 'listing' && r.action === 'skip');
    expect(skippedRows.length).toBeGreaterThan(0); // The paid-pool listing left by the pool tests.
    for (const row of skippedRows) {
      expect(inBatchIds.has(String(row.id))).toBe(false);
      expect((await listingRow(String(row.id))).state).toBe('live');
    }
    expect(second.listingsSkipped).toBe(skippedRows.length);
    expect(
      (await Quote.find({ status: 'withdrawn', withdrawnAt: { $gte: startedTwo } }))
        .map((q) => String(q._id))
        .sort(),
    ).toEqual([...all.quoteIds].sort());

    // Restart batch one: exactly its listing, no more.
    const toRestart = await planRestart(result.stopBatchId);
    expect(toRestart.map((l) => String(l._id))).toEqual([a.listingId]);
    const restarted = await applyRestart(result.stopBatchId, {
      employeeId: admin.employeeId,
      correlationId: 'test-restart',
    });
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.outcome).toBe('restarted');
    expect((await listingRow(a.listingId)).state).toBe('live');
    expect((await listingRow(a.listingId)).stopBatchId ?? null).toBeNull();
    // The seller-paused, hand-stopped and second-batch listings are as they were.
    expect((await listingRow(c.listingId)).state).toBe('paused');
    expect((await listingRow(c.listingId)).stoppedBy ?? null).toBeNull();
    expect((await listingRow(d.listingId)).stoppedBy).toBe('staff');
    expect((await listingRow(bornListing)).state).toBe('paused');
    // Withdrawn quotes do not come back.
    expect((await Quote.findById(quoteId))!.status).toBe('withdrawn');
    // A second restart of the same batch finds nothing.
    expect(await planRestart(result.stopBatchId)).toHaveLength(0);
  });

  it('asks for --confirm-pools before stopping a listing whose seller supplies a pool with commitments', async () => {
    const w = await poolWorld();
    await commitToPoolDirect(w, false);
    const [seller] = w.sellers as [(typeof w.sellers)[number]];

    const plan = await planStop(parseScope(`seller=${seller.sellerDocId}`));
    expect(plan.poolListingIds).toEqual([seller.listingId]);
    const base = { reasonCode: 'maintenance' as const, note: 'x', employeeId: admin.employeeId };
    await expect(applyStop(plan, base)).rejects.toThrow(/--confirm-pools/);
    expect((await listingRow(seller.listingId)).state).toBe('live');
    await applyStop(plan, { ...base, confirmPools: true });
    expect((await listingRow(seller.listingId)).state).toBe('paused');
  });

  it('does not count a pool somebody else supplies against a seller it stops', async () => {
    const w = await poolWorld([SELLER_NET, SELLER_NET + 1000]);
    await commitToPoolDirect(w, true);
    const [, other] = w.sellers as [(typeof w.sellers)[number], (typeof w.sellers)[number]];
    const plan = await planStop(parseScope(`seller=${other.sellerDocId}`));
    expect(plan.poolListingIds).toEqual([]);
    expect(plan.listingIds).toEqual([other.listingId]);
    const result = await applyStop(plan, {
      reasonCode: 'maintenance',
      note: 'x',
      employeeId: admin.employeeId,
    });
    expect(result.listingsStopped).toBe(1);
    expect(result.listingsSkipped).toBe(0);
  });

  it('skips a paid-pool supplier loudly unless --confirm-paid-pools, and then tells the Admins', async () => {
    const w = await poolWorld();
    await commitToPoolDirect(w, true);
    const [seller] = w.sellers as [(typeof w.sellers)[number]];
    const scope = parseScope(`seller=${seller.sellerDocId}`);
    const base = { reasonCode: 'maintenance' as const, note: 'x', employeeId: admin.employeeId };

    // Without the flag the listing is a skip: marked in the plan, counted, left live.
    const plain = await planStop(scope);
    expect(plain.listingIds).toEqual([]);
    const skipRow = plain.rows.find((r) => r.type === 'listing')!;
    expect(skipRow).toMatchObject({ action: 'skip', id: seller.listingId });
    expect(String(skipRow.blocked)).toMatch(/--confirm-paid-pools/);
    const skipped = await applyStop(plain, base);
    expect(skipped.listingsSkipped).toBe(1);
    expect(skipped.rows.find((r) => r.id === seller.listingId)!.outcome).toBe('skipped');
    expect((await listingRow(seller.listingId)).state).toBe('live');

    // With the flag on the plan it still wants both flags on the run.
    const confirmed = await planStop(scope, { confirmPaidPools: true });
    expect(confirmed.listingIds).toEqual([seller.listingId]);
    await expect(applyStop(confirmed, { ...base, confirmPools: true })).rejects.toThrow(
      /--confirm-paid-pools/,
    );
    expect((await listingRow(seller.listingId)).state).toBe('live');
    const done = await applyStop(confirmed, {
      ...base,
      confirmPools: true,
      confirmPaidPools: true,
    });
    expect(done.listingsStopped).toBe(1);
    expect((await listingRow(seller.listingId)).state).toBe('paused');
    const notices = await StaffNotice.find({
      kind: 'pool_needs_settling',
      body: new RegExp(w.poolId),
    });
    expect(notices.map((n) => String(n.employeeId))).toContain(admin.employeeId);
  });

  it('prints the skipped listings and exits non-zero from the command line', async () => {
    const w = await poolWorld();
    await commitToPoolDirect(w, true);
    const [seller] = w.sellers as [(typeof w.sellers)[number]];
    const out = mkdtempSync(join(tmpdir(), 'rectify01-skip-'));
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const args = [
      join('src', 'scripts', 'stopMarketplace.ts'),
      '--scope',
      `seller=${seller.sellerDocId}`,
      '--reason',
      'maintenance',
      '--note',
      'CLI skip test',
      '--out',
      out,
    ];
    const attempt = (extra: string[]) => {
      try {
        const stdout = execFileSync(process.execPath, [tsx, ...args, ...extra], {
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, text: stdout };
      } catch (error) {
        const failed = error as { status: number; stdout: string; stderr: string };
        return { code: failed.status, text: `${failed.stdout}\n${failed.stderr}` };
      }
    };

    // A dry run already says so, and already fails.
    const dry = attempt([]);
    expect(dry.code).toBe(1);
    expect(dry.text).toMatch(/SKIPPED/);
    expect(dry.text).toContain(seller.listingId);
    // So does an apply, and the listing is still live.
    const applied = attempt(['--apply']);
    expect(applied.code).toBe(1);
    expect(applied.text).toContain(seller.listingId);
    expect((await listingRow(seller.listingId)).state).toBe('live');
    // With both flags it stops it, and succeeds.
    const forced = attempt(['--apply', '--confirm-pools', '--confirm-paid-pools']);
    expect(forced.code).toBe(0);
    expect((await listingRow(seller.listingId)).state).toBe('paused');
  }, 240000);

  it('refuses a database that is not in the test allow-list unless told it is prod', () => {
    expect(() =>
      assertDatabaseAllowed('mongodb://127.0.0.1:27017/trifid_test?x=1', false),
    ).not.toThrow();
    expect(() =>
      assertDatabaseAllowed('mongodb+srv://u:p@cluster.example.net/trifid?retryWrites=true', false),
    ).toThrow(/not in the test allow-list/);
    expect(() => assertDatabaseAllowed('mongodb://127.0.0.1:27017/trifid', false)).toThrow();
    expect(() => assertDatabaseAllowed('mongodb://127.0.0.1:27017/trifid', true)).not.toThrow();
    expect(() => parseScope('everything')).toThrow(/--scope/);
    expect(parseScope('product=aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      kind: 'product',
      productId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('runs end to end from the command line: dry run writes nothing, apply stops, restart undoes', () => {
    // Own world, own scope, so the other tests' data does not matter.
    return (async () => {
      const w = await world(1);
      await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 3 });
      const out = mkdtempSync(join(tmpdir(), 'rectify01-'));
      const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const run = (script: string, args: string[]) =>
        execFileSync(
          process.execPath,
          [tsx, join('src', 'scripts', script), ...args, '--out', out],
          {
            env: process.env,
            encoding: 'utf8',
          },
        );
      const stopArgs = [
        '--scope',
        `seller=${w.sellerDocId}`,
        '--reason',
        'maintenance',
        '--note',
        'CLI test',
      ];

      const dry = run('stopMarketplace.ts', stopArgs);
      expect(dry).toMatch(/Dry run: nothing was changed/);
      expect((await listingRow(w.listingId)).state).toBe('live');
      const plans = readdirSync(out).filter((f) => f.startsWith('stop-marketplace-plan-'));
      expect(plans).toHaveLength(1);
      expect(readFileSync(join(out, plans[0]!), 'utf8').split('\r\n')[0]).toBe(
        REPORT_COLUMNS.join(','),
      );

      const applied = run('stopMarketplace.ts', [...stopArgs, '--apply']);
      expect(applied).toMatch(/Stopped 1 listing\(s\)/);
      expect((await listingRow(w.listingId)).state).toBe('paused');
      const batch = /Batch id: (\S+)/.exec(applied)![1]!;
      expect(readdirSync(out).some((f) => f.startsWith('stop-marketplace-result-'))).toBe(true);

      const undoDry = run('restartStopped.ts', ['--batch', batch]);
      expect(undoDry).toMatch(/Dry run/);
      expect((await listingRow(w.listingId)).state).toBe('paused');
      const undone = run('restartStopped.ts', ['--batch', batch, '--apply']);
      expect(undone).toMatch(/Restarted 1 of 1/);
      expect(undone).toMatch(/do not come back/);
      expect((await listingRow(w.listingId)).state).toBe('live');
    })();
  }, 180000);
});

describe('10. marketplace_paused', () => {
  async function setFlag(key: string, value: boolean) {
    await Config.updateOne(
      { key },
      { $set: { value, version: 1, updatedBy: admin.employeeId } },
      { upsert: true },
    );
  }

  it('refuses each entry point with MARKETPLACE_PAUSED, and nothing changes when it is off', async () => {
    const w = await world(4);
    const [buyerA, buyerB, buyerC, buyerD] = w.buyers as [
      World['buyers'][number],
      World['buyers'][number],
      World['buyers'][number],
      World['buyers'][number],
    ];
    const pools = await poolWorld(); // A pool to commit to.

    // State to act on, made while trading is open.
    const live = await liveQuote(w, 0); // A live quote to take.
    const parkedAsk = await demandService.raiseAsk(buyerB.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty: 10,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const parked = await demandService.postQuote(
      w.sellerCp,
      parkedAsk.askId,
      quoteInput({ ratePaiseForIndore: SELLER_NET + 100 }),
      { holdForSales: true },
    ); // A parked quote to give.
    const freshAsk = await demandService.raiseAsk(buyerC.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty: 10,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const { pileId } = await createPileRequest(buyerA.cp, w.lineId, { qty: 5 });
    await demandService.confirmPile(
      w.sellerCp,
      pileId,
      { canSendBoxes: 5, expiryExact: '2029' },
      randomUUID(),
    );
    await runConfirmPileFanout(pileId);
    const deal = (await PileRequest.findOne({ pileId, offerState: 'offered' }))!;
    // A group the seller has yet to decide: confirming it is what would give buyer D a deal.
    const undecided = await createPileRequest(buyerD.cp, w.lineId, { qty: 3 });

    const calls: Record<string, () => Promise<unknown>> = {
      'new listing': () =>
        createListing(w.sellerCp, {
          productId: w.productId,
          scopeType: 'my_area',
          lines: [
            {
              skuId: w.skuId,
              ratePaise: SELLER_NET + 7,
              expiryBand: 'over12',
              moqExact: 1,
              deliveryBand: '48h',
              provenance: 'company',
              qty: 5,
            },
          ],
        } as never),
      'new quote': () =>
        demandService.postQuote(
          w.sellerCp,
          freshAsk.askId,
          quoteInput({ ratePaiseForIndore: SELLER_NET + 200 }),
        ),
      'give a parked quote': () => demandService.releaseQuote(parked.quoteId),
      'give a rate from the board': () =>
        giveRateOnAsk(
          freshAsk.askId,
          { listingLineId: w.lineId },
          { employeeId: sales.employeeId, correlationId: 'test' },
          'call',
        ),
      'new pile request': () => createPileRequest(buyerC.cp, w.lineId, { qty: 2 }),
      'take a quote': () =>
        demandService.acceptAskFill(
          buyerA.cp,
          live.askId,
          { option: 'full', quoteIds: [live.quoteId] },
          'test',
        ),
      'take a deal': () => acceptOffer(String(deal._id), deal.buyerId),
      // Added after the first review: three more doors a pause has to shut.
      'confirm a pile': () =>
        demandService.confirmPile(
          w.sellerCp,
          undecided.pileId,
          { canSendBoxes: 3, expiryExact: '2029' },
          randomUUID(),
        ),
      relist: () => relistListing(w.sellerCp, w.listingId),
      'commit to a pool': () => commitToPool(pools.buyerCp, pools.poolId, { qty: 10 }),
    };

    await setFlag('marketplace_paused', true);
    try {
      for (const [name, call] of Object.entries(calls)) {
        await expect(call(), name).rejects.toMatchObject({
          code: 'MARKETPLACE_PAUSED',
          messageEn: 'Trading is paused for a short while. The desk will call you.',
          status: 409,
          retryable: false,
        });
      }
      // The same envelope over HTTP, as the buyer's app would see it.
      const http = await request(app)
        .post(`/api/v1/listings/lines/${w.lineId}/inquire`)
        .set(
          auth(
            signAccessToken({
              sub: buyerC.cp,
              actorType: 'counterparty',
              counterpartyId: buyerC.cp,
              roles: [],
              permissions: [],
              status: 'active',
            }),
          ),
        )
        .set('Idempotency-Key', idem())
        .send({ qty: 2 });
      expect(http.status).toBe(409);
      expect(http.body.error).toMatchObject({
        code: 'MARKETPLACE_PAUSED',
        message_en: 'Trading is paused for a short while. The desk will call you.',
        retryable: false,
      });
      // Nothing moved while paused.
      expect((await Quote.findById(parked.quoteId))!.status).toBe('pending_sales');
      expect((await Quote.findById(live.quoteId))!.status).toBe('live');
      expect((await PileRequest.findById(deal._id))!.offerState).toBe('offered');
      expect((await Pile.findById(undecided.pileId))!.decision ?? null).toBeNull();
      expect(await PoolCommitment.countDocuments({ poolId: pools.poolId })).toBe(0);
      // The desk sees the banner flag on the bell's call.
      const bell = await request(app).get('/api/v1/staff/notices').set(auth(sales.token));
      expect(bell.body.data.marketplacePaused).toBe(true);
    } finally {
      await setFlag('marketplace_paused', false);
    }

    // Off: the same calls work as before.
    await expect(calls['new listing']!()).resolves.toBeTruthy();
    await expect(calls['give a parked quote']!()).resolves.toBeTruthy();
    await expect(calls['take a deal']!()).resolves.toBeTruthy();
    await expect(calls['take a quote']!()).resolves.toBeTruthy();
    await expect(calls['new pile request']!()).resolves.toBeTruthy();
    await expect(calls['confirm a pile']!()).resolves.toBeTruthy();
    await expect(calls['relist']!()).resolves.toBeUndefined();
    await expect(calls['commit to a pool']!()).resolves.toBeTruthy();
    const bell = await request(app).get('/api/v1/staff/notices').set(auth(sales.token));
    expect(bell.body.data.marketplacePaused).toBe(false);
  });

  it('leaves a new ask unguarded: a buyer can still say what he wants, and the desk calls him', async () => {
    const w = await world(1);
    await setFlag('marketplace_paused', true);
    try {
      await expect(
        demandService.raiseAsk(w.buyers[0]!.cp, {
          skuId: w.skuId,
          allPacks: false,
          qty: 5,
          conditionRequirement: { expiryBand: 'over12' },
        }),
      ).resolves.toBeTruthy();
    } finally {
      await setFlag('marketplace_paused', false);
    }
  });

  it('does not pause what is already traded: a raised order can still be cancelled by Sales', async () => {
    const w = await world(1);
    const { askId, quoteId } = await liveQuote(w);
    const taken = await demandService.acceptAskFill(
      w.buyers[0]!.cp,
      askId,
      { option: 'full', quoteIds: [quoteId] },
      'test',
    );
    await setFlag('marketplace_paused', true);
    try {
      const res = await request(app)
        .post(`/api/v1/staff/sales/orders/${taken.soIds[0]}/cancel`)
        .set(auth(sales.token))
        .send({ callNote: 'He changed his mind.' });
      expect(res.status).toBeLessThan(300);
      expect((await So.findById(taken.soIds[0]))!.state).toBe('cancelled');
    } finally {
      await setFlag('marketplace_paused', false);
    }
  });

  it('refuses requote while pile_requote_enabled is off, and works as before when on', async () => {
    const w = await world(1);
    const { pileId } = await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 4 });
    await expect(demandService.requotePile(w.sellerCp, pileId)).rejects.toMatchObject({
      messageEn: 'Requote is being rebuilt. Decline or confirm instead.',
    });
    expect((await Pile.findById(pileId))!.decision ?? null).toBeNull();

    await setFlag('pile_requote_enabled', true);
    try {
      await demandService.requotePile(w.sellerCp, pileId);
      expect((await Pile.findById(pileId))!.decision).toBe('requoted');
    } finally {
      await setFlag('pile_requote_enabled', false);
    }
    const bell = await request(app).get('/api/v1/staff/notices').set(auth(sales.token));
    expect(bell.body.data.pileRequoteEnabled).toBe(false);
  });
});

describe('11. the wall', () => {
  it('names no seller to Sales and no buyer to Purchase', async () => {
    const w = await world(2);
    await createPileRequest(w.buyers[0]!.cp, w.lineId, { qty: 6 });
    await createPileRequest(w.buyers[1]!.cp, w.lineId, { qty: 4 });
    const { quoteId } = await liveQuote(w, 0);
    const buyerFirms = w.buyers.map((b) => b.firm);

    // What Purchase reads: both previews and both results.
    const previews = [
      await stop(leader.token, w.listingId, REASON),
      await withdraw(leader.token, quoteId, REASON),
    ];
    const results = [
      await withdraw(leader.token, quoteId, CONFIRM),
      await stop(leader.token, w.listingId, CONFIRM),
    ];
    for (const res of [...previews, ...results]) {
      const text = JSON.stringify(res.body);
      for (const firm of buyerFirms) expect(text).not.toContain(firm);
    }

    // What Sales reads: the notices raised by those acts.
    const salesNotices = await StaffNotice.find({
      kind: { $in: ['listing_stopped', 'rate_withdrawn'] },
    });
    expect(salesNotices.length).toBeGreaterThan(0);
    const sellerFirms = (await Counterparty.find({ kind: 'seller' })).map((c) => c.firm!);
    expect(sellerFirms).toContain(w.sellerFirm);
    for (const notice of salesNotices) {
      const text = `${notice.title} ${notice.body} ${notice.link ?? ''}`;
      for (const firm of sellerFirms) expect(text).not.toContain(firm);
    }
    // And nothing was raised for Purchase naming a buyer.
    const purchaseNotices = await StaffNotice.find({
      employeeId: { $in: [leader.employeeId, purchaseExec.employeeId] },
    });
    for (const notice of purchaseNotices) {
      for (const firm of buyerFirms) expect(`${notice.title} ${notice.body}`).not.toContain(firm);
    }
  });

  it('tells the seller TriFid stopped a listing, never why; and keeps both notes from everyone but Purchase', async () => {
    const PRIVATE = 'ZZ-private-note-ZZ';
    const w = await world(1);
    const untouched = await getMyListings(w.sellerCp, {});
    expect(untouched.every((item) => !('stoppedByTriFid' in item))).toBe(true);

    const { quoteId } = await liveQuote(w);
    await stop(leader.token, w.listingId, { ...CONFIRM, note: PRIVATE });
    await withdraw(leader.token, quoteId, { ...CONFIRM, note: PRIVATE });

    // The app can hide Relist and say "Paused by TriFid — call the desk".
    const mine = await getMyListings(w.sellerCp, {});
    expect(mine.find((item) => item.listingId === w.listingId)).toMatchObject({
      state: 'paused',
      stoppedByTriFid: true,
    });
    const quotes = await demandService.listMyQuotes(w.sellerCp);
    expect(quotes.find((q) => q.quoteId === quoteId)!.status).toBe('withdrawn');

    // Neither note is in anything the seller reads, nor in any notice any staff member gets.
    const notices = (await StaffNotice.find({})).map((n) => `${n.title} ${n.body} ${n.link ?? ''}`);
    for (const text of [JSON.stringify(mine), JSON.stringify(quotes), ...notices]) {
      expect(text).not.toContain(PRIVATE);
    }

    // After the restart the flag is gone again.
    await restart(leader.token, w.listingId);
    const after = await getMyListings(w.sellerCp, {});
    expect(after.find((item) => item.listingId === w.listingId)).not.toHaveProperty(
      'stoppedByTriFid',
    );
  });
});

describe('the read-only data audit (RECTIFY-01_PLAN §3.2)', () => {
  it('finds each of the seven things it is told to look for', async () => {
    const w = await world(2);
    const now = new Date();
    const past = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

    // 1. An ask past its TTL.
    const stale = await demandService.raiseAsk(w.buyers[0]!.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty: 8,
      conditionRequirement: { expiryBand: 'over12' },
    });
    await Ask.updateOne({ _id: stale.askId }, { $set: { ttlAt: past(48) } });
    // 2. A live quote past its binding.
    const bound = await liveQuote(w, 1);
    await Quote.updateOne({ _id: bound.quoteId }, { $set: { bindingUntil: past(3) } });
    // 3. A quote parked over 24 h.
    const parkedAsk = await demandService.raiseAsk(w.buyers[0]!.cp, {
      skuId: w.skuId,
      allPacks: false,
      qty: 8,
      conditionRequirement: { expiryBand: 'over12' },
    });
    const parked = await demandService.postQuote(
      w.sellerCp,
      parkedAsk.askId,
      quoteInput({ ratePaiseForIndore: SELLER_NET + 9 }),
      { holdForSales: true },
    );
    await Quote.collection.updateOne(
      { _id: (await Quote.findById(parked.quoteId))!._id },
      { $set: { createdAt: past(30) } },
    );
    // 4. A quote-born line promising more than its open quotes can supply.
    const bornLineId = (await Quote.findById(parked.quoteId))!.listingLineId;
    await ListingLine.updateOne({ _id: bornLineId }, { $set: { qty: 500 } });
    // 5. An order marked intra-state whose buyer's GSTIN is not Madhya Pradesh's.
    const taken = await liveQuote(w, 0);
    const buyerCp = w.buyers[0]!.cp;
    const { soIds } = await demandService.acceptAskFill(
      buyerCp,
      taken.askId,
      { option: 'full', quoteIds: [taken.quoteId] },
      'test',
    );
    const soNo = (await So.findById(soIds[0]))!.soNo;
    await Counterparty.updateOne(
      { _id: buyerCp },
      { $set: { gstin: `08${(await Counterparty.findById(buyerCp))!.gstin!.slice(2)}` } },
    );
    // 6. A declared payment still waiting after 48 h.
    const { UpcomingReceipt } = await import('../src/models/UpcomingReceipt.js');
    const receipt = await UpcomingReceipt.create({
      buyerId: w.buyers[0]!.docId,
      amountPaise: 100000,
      claimedAt: past(60),
      method: 'utr',
      utr: 'U1',
      soIds,
    });
    // 7. A requoted pile with a buyer still open on it.
    const { pileId } = await createPileRequest(w.buyers[1]!.cp, w.lineId, { qty: 3 });
    await Pile.updateOne({ _id: pileId }, { $set: { decision: 'requoted', decidedAt: now } });

    const audit = await runAudit(now);
    const byKey = new Map(audit.checks.map((c) => [c.key, c]));
    expect(byKey.get('asks-past-ttl')!.rows.map((r) => r.ask_id)).toContain(stale.askId);
    expect(byKey.get('quotes-live-past-binding')!.rows.map((r) => r.quote_id)).toContain(
      bound.quoteId,
    );
    expect(byKey.get('quotes-parked-over-24h')!.rows.map((r) => r.quote_id)).toContain(
      parked.quoteId,
    );
    const over = byKey
      .get('lines-over-quotes')!
      .rows.find((r) => r.listing_line_id === String(bornLineId))!;
    expect(over).toMatchObject({
      line_boxes: 500,
      boxes_open_quotes_can_supply: 10,
      boxes_over: 490,
    });
    expect(
      byKey.get('orders-wrong-place-of-supply')!.rows.find((r) => r.so_no === soNo),
    ).toMatchObject({ buyer_gstin_state_code: '08', place_of_supply: 'intra_state' });
    expect(byKey.get('receipts-waiting-over-48h')!.rows.map((r) => r.receipt_id)).toContain(
      String(receipt._id),
    );
    expect(byKey.get('piles-requoted-stranded')!.rows.map((r) => r.pile_id)).toContain(pileId);
    // The audit wrote nothing.
    expect((await Ask.findById(stale.askId))!.state).toBe('open');
    expect(audit.checks).toHaveLength(7);
    expect(toCsv(['a'], [{ a: 'x,"y"' }])).toBe('a\r\n"x,""y"""\r\n');
  });
});
