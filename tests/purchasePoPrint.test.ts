import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Po } from '../src/models/Po.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { computeSellerLineMoney } from '../src/shared/pricing.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

/**
 * 3 Nov (My view sheet) — the data behind "Download PDF" on a purchase order, and the extra
 * fields the Sellers search reads. The PDF itself is built in the admin app.
 */
const app = createApp();

function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

async function releasedPo() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku('Medium');
  await seedMarginCell('Medium', 'Dealer', 0.05, admin.employeeId);
  const so = await request(app)
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
  expect(so.status).toBe(201);
  const soId = so.body.data.soId as string;
  const paid = await request(app)
    .post(`/api/v1/staff/sales/orders/${soId}/mark-paid`)
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ utr: `UTR${Date.now()}${Math.floor(Math.random() * 100000)}`, callNote: 'Paid.' });
  expect(paid.status).toBe(201);
  const poId = paid.body.data.poId as string;
  return { poId, buyerId, sellerId, skuId, sales, purchase, admin };
}

const get = (token: string, path: string) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

describe('GET /staff/purchase/pos/:poId/print', () => {
  it('gives the seller’s purchase order: company, seller, lines, GST split and the dispatch line', async () => {
    const w = await releasedPo();
    const res = await get(w.purchase.token, `/staff/purchase/pos/${w.poId}/print`);
    expect(res.status).toBe(200);
    const po = (await Po.findById(w.poId))!;
    const seller = (await Seller.findById(w.sellerId))!;
    const counterparty = (await Counterparty.findById(seller.counterpartyId))!;
    const sku = (await Sku.findById(w.skuId))!;

    expect(res.body.data).toMatchObject({
      poNo: po.poNo,
      company: {
        name: 'TriFid Stores Pvt. Ltd.',
        addressLines: ['Runija Road, Barnagar'],
        gstin: '23AAHCT4156E1ZJ',
      },
      seller: { firm: counterparty.firm, gstin: counterparty.gstin },
      terms: [], // Not supplied yet: no terms section.
    });
    // The seller's own net rate, frozen on the order; the amount is boxes × units per box × rate.
    const line = res.body.data.lines[0];
    expect(line).toMatchObject({
      boxes: 10,
      ratePaise: 40000,
      baseUnit: sku.baseUnit,
      baseUnitsPerBox: sku.baseUnitsPerBox,
    });
    const kind = counterparty.gstin?.startsWith('23') ? 'intra_state' : 'inter_state';
    const money = computeSellerLineMoney(10, sku.baseUnitsPerBox, 40000, kind);
    expect(res.body.data.taxablePaise).toBe(money.taxablePaise);
    expect(res.body.data.totalPaise).toBe(money.totalPaise);
    expect(res.body.data.gst).toMatchObject({
      ratePercent: 18,
      kind,
      cgstPaise: money.taxSplit.cgstPaise,
      sgstPaise: money.taxSplit.sgstPaise,
      igstPaise: money.taxSplit.igstPaise,
    });
    // His same-day line, on or after the release, never before it.
    expect(new Date(res.body.data.dispatchBy).getTime()).toBeGreaterThanOrEqual(
      po.dispatchDueDate.getTime(),
    );
  });

  it('splits the GST by state: CGST + SGST within Madhya Pradesh, IGST from anywhere else', async () => {
    const w = await releasedPo();
    const seller = (await Seller.findById(w.sellerId))!;
    const path = `/staff/purchase/pos/${w.poId}/print`;

    await Counterparty.updateOne(
      { _id: seller.counterpartyId },
      { $set: { gstin: '23AAAAA0000A1Z5' } },
    );
    const same = (await get(w.purchase.token, path)).body.data;
    expect(same.gst.kind).toBe('intra_state');
    expect(same.gst.igstPaise).toBe(0);
    expect(same.gst.cgstPaise + same.gst.sgstPaise + same.taxablePaise).toBe(same.totalPaise);

    await Counterparty.updateOne(
      { _id: seller.counterpartyId },
      { $set: { gstin: '27AAAAA0000A1Z5' } },
    );
    const other = (await get(w.purchase.token, path)).body.data;
    expect(other.gst.kind).toBe('inter_state');
    expect(other.gst.cgstPaise).toBe(0);
    expect(other.gst.sgstPaise).toBe(0);
    expect(other.gst.igstPaise + other.taxablePaise).toBe(other.totalPaise);
  });

  it('keeps the desk’s wall: no buyer identity, rate or margin, and no bank details', async () => {
    const w = await releasedPo();
    const res = await get(w.purchase.token, `/staff/purchase/pos/${w.poId}/print`);
    const buyer = (await Buyer.findById(w.buyerId))!;
    const buyerCp = (await Counterparty.findById(buyer.counterpartyId))!;
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(String(buyerCp._id));
    expect(text).not.toContain(buyerCp.firm ?? '\u0000');
    expect(text.toLowerCase()).not.toContain('margin');
    expect(text.toLowerCase()).not.toContain('buyer');
    expect(text).not.toContain('ICIC');
  });

  it('is for Purchase only, needs a sign-in, and says so for a PO that is not there', async () => {
    const w = await releasedPo();
    const path = `/staff/purchase/pos/${w.poId}/print`;
    expect((await get(w.sales.token, path)).status).toBe(403);
    expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
    const missing = await get(
      w.purchase.token,
      '/staff/purchase/pos/000000000000000000000000/print',
    );
    expect(missing.status).toBe(404);
    const malformed = await get(w.purchase.token, '/staff/purchase/pos/not-an-id/print');
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
  });
});

describe('GET /staff/purchase/matrix/by-seller — what the Sellers search reads', () => {
  it('carries each seller’s proprietor, mobile and GSTIN', async () => {
    const purchase = await staffToken(app, 'purchase');
    const sellerId = await createApprovedSeller(app, purchase.token);
    const seller = (await Seller.findById(sellerId))!;
    const counterparty = (await Counterparty.findById(seller.counterpartyId))!;
    const res = await get(purchase.token, '/staff/purchase/matrix/by-seller');
    expect(res.status).toBe(200);
    const row = (res.body.data as Array<{ sellerId: string }>).find((r) => r.sellerId === sellerId);
    expect(row).toMatchObject({
      firm: counterparty.firm,
      ownerName: counterparty.ownerName ?? null,
      mobile: counterparty.contactMobile ?? counterparty.mobile ?? null,
      gstin: counterparty.gstin ?? null,
    });
  });
});
