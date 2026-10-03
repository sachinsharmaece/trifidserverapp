import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import type { AccountsSnapshot } from '../src/modules/accounts/accounts.types.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

const app = createApp();

function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

async function snapshotAs(token: string) {
  return request(app)
    .get('/api/v1/staff/accounts/snapshot')
    .set('Authorization', `Bearer ${token}`);
}

async function seed() {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku();
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
  const { soId, soNo } = soRes.body.data as { soId: string; soNo: string };
  return { sales, purchase, accounts, buyerId, sellerId, soId, soNo };
}

describe('Accounts desk — the read snapshot', () => {
  it('is closed to Sales: the snapshot puts a buyer and a seller on one record (BR-070)', async () => {
    const sales = await staffToken(app, 'sales');
    const res = await snapshotAs(sales.token);
    expect(res.status).toBe(403);
  });

  it('needs a sign-in at all', async () => {
    const res = await request(app).get('/api/v1/staff/accounts/snapshot');
    expect(res.status).toBe(401);
  });

  it('shows an unpaid order inside its window, with the server’s own money figures', async () => {
    const f = await seed();
    const so = await So.findById(f.soId);

    const res = await snapshotAs(f.accounts.token);
    expect(res.status).toBe(200);
    const snap = res.body.data as AccountsSnapshot;

    const row = snap.sos.find((s) => s.id === f.soNo);
    expect(row).toBeDefined();
    expect(row!.state).toBe('awaiting_payment');
    expect(row!.leftH).toBeGreaterThan(0);
    expect(row!.leftH).toBeLessThanOrEqual(24);
    expect(row!.po).toBeNull(); // INV-01 — no PO until the money is in.
    // The total is the order's own, and taxable + GST always adds up to it (no recomputation at 18%).
    expect(row!.totalPaise).toBe(so!.totalPaise);
    expect(row!.taxablePaise + row!.gstPaise).toBe(row!.totalPaise);
    expect(row!.lines[0]?.qty).toBe(10);
    expect(row!.lines[0]?.item).toMatch(/^Brand /);

    // Both counterparties resolve to names.
    const names = new Map(snap.parties.map((p) => [p.id, p]));
    expect(names.get(f.buyerId)?.type).toBe('buyer');
    expect(names.get(f.sellerId)?.type).toBe('seller');
    expect(names.get(f.sellerId)?.verified).toBe(true); // approved, bank detail past cooling.
  });

  it('follows the money: claim → picked orders → posted line → PO, each where the desk expects it', async () => {
    const f = await seed();
    const so = await So.findById(f.soId);

    // A claim Sales has not picked orders for yet.
    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(f.buyerId, {
      amountPaise: so!.totalPaise,
      method: 'utr',
      utr: `UTR-${Date.now()}-${Math.random()}`,
    });
    let snap = (await snapshotAs(f.accounts.token)).body.data as AccountsSnapshot;
    let claim = snap.upcoming.find((u) => u.key === upcomingReceiptId);
    expect(claim?.state).toBe('waiting');
    expect(claim?.sos).toEqual([]);

    // Sales picks the order — it is now labelled with it.
    const allocateRes = await request(app)
      .post(`/api/v1/staff/upcoming-receipts/${upcomingReceiptId}/allocate`)
      .set('Authorization', `Bearer ${f.sales.token}`)
      .send({ soIds: [f.soId] });
    expect(allocateRes.status).toBe(200);
    snap = (await snapshotAs(f.accounts.token)).body.data as AccountsSnapshot;
    claim = snap.upcoming.find((u) => u.key === upcomingReceiptId);
    expect(claim?.sos).toEqual([f.soNo]);

    // Accounts posts it: it leaves the upcoming list and lands in the bank book against the order.
    const postRes = await request(app)
      .post(`/api/v1/staff/bank/${upcomingReceiptId}/post`)
      .set('Authorization', `Bearer ${f.accounts.token}`)
      .set('Idempotency-Key', idemKey())
      .send({
        utr: `STMT-${Date.now()}-${Math.random()}`,
        remitterAccountNumber: '99988877766',
        remitterIfsc: 'HDFC0001234',
      });
    expect(postRes.status).toBe(201);
    snap = (await snapshotAs(f.accounts.token)).body.data as AccountsSnapshot;
    expect(snap.upcoming.find((u) => u.key === upcomingReceiptId)).toBeUndefined();
    const line = snap.bankbook.find((b) => b.ref === f.soNo);
    expect(line).toMatchObject({
      kind: 'in',
      purpose: 'receipt',
      party: f.buyerId,
      amountPaise: so!.totalPaise,
    });
    expect(line!.from).toMatch(/^···\d{4}$/); // masked — never the whole account number.
    expect(snap.bankClosingPaise).toBeGreaterThanOrEqual(so!.totalPaise);

    // Purchase issues the PO: the order moves on, and the PO is not payable yet
    // (goods not in, no inspection, no bill, no Accounts confirmation).
    const poRes = await request(app)
      .post(`/api/v1/staff/so/${f.soId}/po`)
      .set('Authorization', `Bearer ${f.purchase.token}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(poRes.status).toBe(201);
    const { poNo } = poRes.body.data as { poNo: string };
    snap = (await snapshotAs(f.accounts.token)).body.data as AccountsSnapshot;
    const order = snap.sos.find((s) => s.id === f.soNo);
    expect(order?.state).toBe('awaiting_goods');
    expect(order?.po).toBe(poNo);
    const po = snap.pos.find((p) => p.id === poNo);
    expect(po).toMatchObject({
      so: f.soNo,
      received: false,
      inspected: false,
      billed: false,
      confirmed: false,
      bankOk: true,
      paid: false,
      failed: false,
    });
    // The seller is paid what he bills; until he bills, the PO total stands in.
    expect(po!.payablePaise).toBe(po!.totalPaise);
    expect(po!.taxablePaise + po!.gstPaise).toBe(po!.totalPaise);
  });

  it('never exposes a whole bank account number anywhere in the snapshot', async () => {
    const f = await seed();
    const res = await snapshotAs(f.accounts.token);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body.data);
    expect(text).not.toContain('99988877766');
    expect(text).not.toMatch(/accountEncrypted|remitterAccountEncrypted|passwordHash/);
  });
});
