import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Bankbook } from '../src/models/Bankbook.js';
import { Chain } from '../src/models/Chain.js';
import { PaymentRun } from '../src/models/PaymentRun.js';
import { Refund } from '../src/models/Refund.js';
import { signReauthToken } from '../src/shared/tokens.js';
import type { AccountsSnapshot } from '../src/modules/accounts/accounts.types.js';
import { staffToken, createApprovedBuyer } from './m4helpers.js';

const app = createApp();

function idemKey(): string {
  return `test-${Date.now()}-${Math.random()}`;
}

/** A payable refund — the cheapest thing a batch can hold. */
async function seed() {
  const sales = await staffToken(app, 'sales');
  const accounts = await staffToken(app, 'accounts');
  const controller = await staffToken(app, 'controller');
  const buyerId = await createApprovedBuyer(app, sales.token);
  const chain = await Chain.create({
    chainNo: `C-${Date.now()}-${Math.random()}`,
    source: 'listed',
  });
  const refund = await Refund.create({
    chainId: chain._id,
    buyerId,
    amountPaise: 123400,
    reasonCode: 'supply_failure_full',
    state: 'payable',
    targetAccountMasked: '····1234',
  });
  return { accounts, controller, refundId: String(refund._id) };
}

async function build(token: string, refundId: string) {
  return request(app)
    .post('/api/v1/staff/payment-runs')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idemKey())
    .send({ items: [{ kind: 'refund', refId: refundId }] });
}

function sendBack(token: string, runId: string, body: unknown) {
  return request(app)
    .post(`/api/v1/staff/payment-runs/${runId}/send-back`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idemKey())
    .send(body as object);
}

describe('Payment runs — the checker can send a batch back', () => {
  it('is the checker’s call: Accounts, who builds, cannot send back', async () => {
    const f = await seed();
    const built = await build(f.accounts.token, f.refundId);
    expect(built.status).toBe(201);
    const runId = built.body.data.paymentRunId as string;

    const res = await sendBack(f.accounts.token, runId, { reason: 'changed my mind' });
    expect(res.status).toBe(403);
    expect((await PaymentRun.findById(runId))!.state).toBe('built');
  });

  it('needs a reason', async () => {
    const f = await seed();
    const runId = (await build(f.accounts.token, f.refundId)).body.data.paymentRunId as string;

    const res = await sendBack(f.controller.token, runId, { reason: '   ' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await PaymentRun.findById(runId))!.state).toBe('built');
  });

  it('closes the run with the reason, moves no money, and frees its items', async () => {
    const f = await seed();
    const runId = (await build(f.accounts.token, f.refundId)).body.data.paymentRunId as string;
    const linesBefore = await Bankbook.countDocuments({});

    const res = await sendBack(f.controller.token, runId, {
      reason: 'Wrong account on the refund — hold until the buyer confirms it',
    });
    expect(res.status).toBe(200);

    const run = await PaymentRun.findById(runId);
    expect(run!.state).toBe('sent_back');
    expect(run!.sentBackReason).toMatch(/Wrong account/);
    expect(String(run!.sentBackBy)).toBe(f.controller.employeeId);
    expect(run!.sentBackAt).toBeInstanceOf(Date);
    // Nothing moved: no book line, and the refund is still payable.
    expect(await Bankbook.countDocuments({})).toBe(linesBefore);
    expect((await Refund.findById(f.refundId))!.state).toBe('payable');

    // The desk shows it as sent back, with who and why, and the item is no longer "in a batch".
    const snap = (
      await request(app)
        .get('/api/v1/staff/accounts/snapshot')
        .set('Authorization', `Bearer ${f.accounts.token}`)
    ).body.data as AccountsSnapshot;
    const shown = snap.runs.find((r) => r.key === runId);
    expect(shown).toMatchObject({ state: 'sent_back', sentBackReason: run!.sentBackReason });
    expect(shown!.sentBackBy).toBeTruthy();
    expect(
      snap.runs.filter((r) => r.state === 'awaiting_release').flatMap((r) => r.items),
    ).not.toContainEqual(expect.objectContaining({ key: f.refundId }));

    // …and the same refund can go into a new batch.
    expect((await build(f.accounts.token, f.refundId)).status).toBe(201);
  });

  it('can no longer be released once sent back — no money moves', async () => {
    const f = await seed();
    const runId = (await build(f.accounts.token, f.refundId)).body.data.paymentRunId as string;
    expect((await sendBack(f.controller.token, runId, { reason: 'declined' })).status).toBe(200);
    const linesBefore = await Bankbook.countDocuments({});

    const release = await request(app)
      .post(`/api/v1/staff/payment-runs/${runId}/release`)
      .set('Authorization', `Bearer ${f.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .set('X-Reauth-Token', signReauthToken(f.controller.employeeId))
      .send({});
    expect(release.status).toBeGreaterThanOrEqual(400);
    expect(await Bankbook.countDocuments({})).toBe(linesBefore);
    expect((await Refund.findById(f.refundId))!.state).toBe('payable');
    expect((await PaymentRun.findById(runId))!.state).toBe('sent_back');
  });

  it('cannot be sent back once released, and cannot be sent back twice', async () => {
    const f = await seed();
    const runId = (await build(f.accounts.token, f.refundId)).body.data.paymentRunId as string;
    const release = await request(app)
      .post(`/api/v1/staff/payment-runs/${runId}/release`)
      .set('Authorization', `Bearer ${f.controller.token}`)
      .set('Idempotency-Key', idemKey())
      .set('X-Reauth-Token', signReauthToken(f.controller.employeeId))
      .send({});
    expect(release.status).toBe(200);

    const late = await sendBack(f.controller.token, runId, { reason: 'too late' });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect((await PaymentRun.findById(runId))!.state).toBe('released');

    const f2 = await seed();
    const run2 = (await build(f2.accounts.token, f2.refundId)).body.data.paymentRunId as string;
    expect((await sendBack(f2.controller.token, run2, { reason: 'once' })).status).toBe(200);
    expect(
      (await sendBack(f2.controller.token, run2, { reason: 'twice' })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
