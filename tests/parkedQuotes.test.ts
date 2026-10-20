import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Quote } from '../src/models/Quote.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { Sku } from '../src/models/Sku.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

/**
 * A quote is born parked: already a listing line for every buyer, but the asking buyer is shown
 * it as a rate on his ask only when Sales gives it to him — any number of them, one by one.
 */

const app = createApp();

const quoteInput = (overrides: Record<string, unknown> = {}) => ({
  ratePaiseForIndore: 40000,
  qtyAvailable: 10,
  expiryBand: 'over12' as const,
  expiryExact: '12/2099',
  deliveryBand: '48h' as const,
  provenance: 'company' as const,
  daysToIndore: 2,
  ...overrides,
});

async function world(skuClass: 'Medium' = 'Medium') {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  await seedMarginCell(skuClass, 'Dealer', 0.05, admin.employeeId);
  const buyerId = await createApprovedBuyer(app, sales.token);
  const buyerCounterpartyId = (await Buyer.findById(buyerId))!.counterpartyId!.toString();
  const sellerId = await createApprovedSeller(app, purchase.token);
  const sellerCounterpartyId = (await Seller.findById(sellerId))!.counterpartyId!.toString();
  const skuId = await createTestSku(skuClass);
  return { sales, purchase, buyerId, buyerCounterpartyId, sellerId, sellerCounterpartyId, skuId };
}

async function raiseAsk(
  buyerCounterpartyId: string,
  target: { skuId: string } | { productId: string },
) {
  const { askId } = await demandService.raiseAsk(buyerCounterpartyId, {
    ...target,
    allPacks: false,
    qty: 10,
    conditionRequirement: { expiryBand: 'over12' },
  });
  return askId;
}

const give = (token: string, quoteId: string) =>
  request(app)
    .post(`/api/v1/staff/sales/quotes/${quoteId}/give`)
    .set('Authorization', `Bearer ${token}`)
    .send({ callNote: 'Rang him.' });

describe('parked quotes — listed at once, given to the asking buyer by Sales', () => {
  it('parks the quote, publishes it as an all-India listing line, and hides it from the asking buyer', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });

    const { quoteId } = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });

    const quote = await Quote.findById(quoteId);
    expect(quote!.status).toBe('pending_sales');
    expect(quote!.skuId!.toString()).toBe(w.skuId);
    const line = await ListingLine.findById(quote!.listingLineId);
    expect(line!.skuId!.toString()).toBe(w.skuId);
    expect(line!.qty).toBe(10);
    const listing = await Listing.findById(line!.listingId);
    expect(listing).toMatchObject({ origin: 'quote_born', scopeType: 'all_india', state: 'live' });

    // The ask has not moved and no hold has started.
    const ask = await Ask.findById(askId);
    expect(ask!.state).toBe('open');
    expect(ask!.holdExpiresAt).toBeFalsy();

    // The asking buyer's own list shows no quote on his ask.
    const mine = await demandService.listMyAsks(w.buyerCounterpartyId);
    expect(mine.find((a) => a.askId === askId)!.quotes).toEqual([]);

    // The seller still sees his rate as given.
    const theirs = await demandService.listMyQuotes(w.sellerCounterpartyId);
    expect(theirs.find((q) => q.quoteId === quoteId)!.status).toBe('live');
  });

  it('lets Sales give several quotes on one ask, one by one; the first starts the hold, a later one never restarts it', async () => {
    const w = await world();
    const purchase = w.purchase;
    const otherSellerId = await createApprovedSeller(app, purchase.token);
    const otherSellerCp = (await Seller.findById(otherSellerId))!.counterpartyId!.toString();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });

    const first = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });
    const second = await demandService.postQuote(
      otherSellerCp,
      askId,
      quoteInput({ ratePaiseForIndore: 39000 }),
      { holdForSales: true },
    );

    const file = await request(app)
      .get(`/api/v1/staff/sales/buyers/${w.buyerId}`)
      .set('Authorization', `Bearer ${w.sales.token}`);
    const row = (
      file.body.data.openAsks as Array<{
        askId: string;
        pendingQuotes: Array<{ ratePaise: number | null }>;
      }>
    ).find((a) => a.askId === askId)!;
    expect(row.pendingQuotes).toHaveLength(2);
    // Both are his rate: net plus the 5% Dealer cell — never the seller's net.
    expect(row.pendingQuotes.every((q) => q.ratePaise !== null && q.ratePaise > 39000)).toBe(true);

    expect((await give(w.sales.token, first.quoteId)).status).toBe(201);
    const holdAfterFirst = (await Ask.findById(askId))!.holdExpiresAt!;
    expect((await Ask.findById(askId))!.state).toBe('quoted');

    // The moment a rate is given the ask leaves "He asked" and sits under "Rate given".
    const mid = await request(app)
      .get(`/api/v1/staff/sales/buyers/${w.buyerId}`)
      .set('Authorization', `Bearer ${w.sales.token}`);
    expect(
      (mid.body.data.openAsks as Array<{ askId: string }>).some((a) => a.askId === askId),
    ).toBe(false);
    expect((mid.body.data.liveQuotes as Array<{ quoteId: string }>).map((q) => q.quoteId)).toEqual([
      first.quoteId,
    ]);

    expect((await give(w.sales.token, second.quoteId)).status).toBe(201);
    expect((await Ask.findById(askId))!.holdExpiresAt!.getTime()).toBe(holdAfterFirst.getTime());

    // The buyer now sees both, at his own tier rate.
    const mine = await demandService.listMyAsks(w.buyerCounterpartyId);
    expect(mine.find((a) => a.askId === askId)!.quotes).toHaveLength(2);

    // Giving a quote twice is refused.
    expect((await give(w.sales.token, first.quoteId)).status).toBe(400);
  });

  it('needs the pack when the ask is for a product, and refuses a pack of another product', async () => {
    const w = await world();
    const sku = await Sku.findById(w.skuId);
    const productId = (sku!.productId as unknown as { toString(): string }).toString();
    const askId = await raiseAsk(w.buyerCounterpartyId, { productId });

    await expect(
      demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), { holdForSales: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const otherSkuId = await createTestSku('Medium');
    await expect(
      demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput({ skuId: otherSkuId }), {
        holdForSales: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const { quoteId } = await demandService.postQuote(
      w.sellerCounterpartyId,
      askId,
      quoteInput({ skuId: w.skuId }),
      { holdForSales: true },
    );
    expect((await Quote.findById(quoteId))!.skuId!.toString()).toBe(w.skuId);
  });

  it('refuses a quote the listing would refuse — and leaves no quote behind', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });
    await expect(
      demandService.postQuote(
        w.sellerCounterpartyId,
        askId,
        quoteInput({ expiryExact: '01/2026' }),
        {
          holdForSales: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'SHELF_LIFE_FLOOR' });
    expect(await Quote.countDocuments({ askId })).toBe(0);
  });

  it('reuses an identical live listing line rather than listing it twice', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });
    const a = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });
    const b = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });
    const qa = await Quote.findById(a.quoteId);
    const qb = await Quote.findById(b.quoteId);
    expect(qb!.listingLineId!.toString()).toBe(qa!.listingLineId!.toString());
  });

  it('closes the quotes still parked when the buyer walks away, but leaves the listing line live', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });
    const { quoteId } = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });
    const lineId = (await Quote.findById(quoteId))!.listingLineId;

    await demandService.declineAsk(w.buyerCounterpartyId, askId);

    expect((await Quote.findById(quoteId))!.status).toBe('expired');
    const line = await ListingLine.findById(lineId);
    expect((await Listing.findById(line!.listingId))!.state).toBe('live');
    // And it can no longer be given.
    expect((await give(w.sales.token, quoteId)).status).toBe(400);
  });

  it('keeps Sales\' own "give rate" off the parked path — the buyer sees it straight away', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });
    const { quoteId } = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput());
    expect((await Quote.findById(quoteId))!.status).toBe('live');
    expect((await Ask.findById(askId))!.state).toBe('quoted');
  });

  it('giving the board line a seller already quoted gives that quote — no second one, and the ask leaves "He asked"', async () => {
    const w = await world();
    const askId = await raiseAsk(w.buyerCounterpartyId, { skuId: w.skuId });
    const { quoteId } = await demandService.postQuote(w.sellerCounterpartyId, askId, quoteInput(), {
      holdForSales: true,
    });
    const lineId = (await Quote.findById(quoteId))!.listingLineId!.toString();

    const res = await request(app)
      .post(`/api/v1/staff/sales/asks/${askId}/give-rate`)
      .set('Authorization', `Bearer ${w.sales.token}`)
      .send({ listingLineId: lineId, callNote: 'Gave him the board rate.' });
    expect(res.status).toBe(201);
    expect(res.body.data.quoteId).toBe(quoteId);

    // One quote on the ask, now live — not a parked one beside a fresh one.
    const quotes = await Quote.find({ askId });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.status).toBe('live');

    const file = await request(app)
      .get(`/api/v1/staff/sales/buyers/${w.buyerId}`)
      .set('Authorization', `Bearer ${w.sales.token}`);
    expect(
      (file.body.data.openAsks as Array<{ askId: string }>).some((a) => a.askId === askId),
    ).toBe(false);
    expect(
      (file.body.data.liveQuotes as Array<{ askId: string }>).filter((q) => q.askId === askId),
    ).toHaveLength(1);
  });
});
