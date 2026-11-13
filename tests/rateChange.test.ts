import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Buyer } from '../src/models/Buyer.js';
import { Employee } from '../src/models/Employee.js';
import { Quote } from '../src/models/Quote.js';
import { RateChangeRequest } from '../src/models/RateChangeRequest.js';
import { RateOverride } from '../src/models/RateOverride.js';
import { Role } from '../src/models/Role.js';
import { Seller } from '../src/models/Seller.js';
import { SoLine } from '../src/models/SoLine.js';
import { StaffNotice } from '../src/models/StaffNotice.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { acceptAskFillSchema } from '../src/modules/demand/demand.validation.js';
import { loginStaff, randomEmail, randomMobile } from './helpers.js';
import { salesLeader } from './buyerHelpers.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';

/**
 * 4 Nov — Rate given → Change. Sales asks to confirm a held rate at other boxes and/or another
 * rate; the requester's Sales Leader (or Admin) approves; Confirm then raises the order at the
 * approved figures. The quote itself is never edited.
 */

const app = createApp();
const SELLER_NET = 40000;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => `rc-${Date.now()}-${Math.random()}`;

type Staff = { token: string; employeeId: string };
let admin: Staff;
let leader: Staff;
let exec: Staff;
let buyerId: string;
let buyerCounterpartyId: string;
let sellerCounterpartyId: string;
let skuId: string;

async function salesPerson(
  person: string,
  positions: string[],
  reportsToSalesLeaderId: string | 'self',
): Promise<Staff> {
  const roles = await Role.find({ key: 'sales' });
  const password = 'CorrectHorse123';
  const email = randomEmail();
  const employee = await Employee.create({
    person,
    email,
    mobile: randomMobile(),
    passwordHash: await bcrypt.hash(password, 10),
    roleIds: roles.map((r) => r._id),
    positions,
    active: true,
  });
  employee.reportsToSalesLeaderId = (
    reportsToSalesLeaderId === 'self' ? employee._id : reportsToSalesLeaderId
  ) as never;
  await employee.save();
  return { token: await loginStaff(app, email, password), employeeId: String(employee._id) };
}

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  const purchase = await staffToken(app, 'purchase');
  const registrar = await staffToken(app, 'sales');
  leader = await salesLeader(app);
  exec = await salesPerson('Test Sales Exec', ['SALES_EXEC'], leader.employeeId);
  await seedMarginCell('Medium', 'Dealer', 0.05, admin.employeeId);
  buyerId = await createApprovedBuyer(app, registrar.token);
  buyerCounterpartyId = String((await Buyer.findById(buyerId))!.counterpartyId);
  // His book belongs to the executive, who sits in the leader's team.
  await BookAssignment.updateOne({ buyerId }, { $set: { ownerEmployeeId: exec.employeeId } });
  const sellerId = await createApprovedSeller(app, purchase.token);
  sellerCounterpartyId = String((await Seller.findById(sellerId))!.counterpartyId);
  skuId = await createTestSku('Medium');
});

/** A live rate on a fresh ask for 10 boxes — the seller quoted 10 and Sales gave it to him. */
async function liveQuote(): Promise<{ askId: string; quoteId: string }> {
  const { askId } = await demandService.raiseAsk(buyerCounterpartyId, {
    skuId,
    allPacks: false,
    qty: 10,
    conditionRequirement: { expiryBand: 'over12' },
  });
  const { quoteId } = await demandService.postQuote(
    sellerCounterpartyId,
    askId,
    {
      ratePaiseForIndore: SELLER_NET,
      qtyAvailable: 10,
      expiryBand: 'over12',
      expiryExact: '12/2099',
      deliveryBand: '48h',
      provenance: 'company',
      daysToIndore: 2,
    },
    { holdForSales: true },
  );
  const given = await request(app)
    .post(`/api/v1/staff/sales/quotes/${quoteId}/give`)
    .set(auth(exec.token))
    .send({ callNote: 'Rang him.' });
  expect(given.status).toBe(201);
  return { askId, quoteId };
}

interface FileQuote {
  quoteId: string;
  ratePaise: number;
  rateChange: { requestId: string; status: string; canDecide: boolean } | null;
}
async function liveQuoteRow(token: string, quoteId: string): Promise<FileQuote> {
  const file = await request(app).get(`/api/v1/staff/sales/buyers/${buyerId}`).set(auth(token));
  expect(file.status).toBe(200);
  return (file.body.data.liveQuotes as FileQuote[]).find((q) => q.quoteId === quoteId)!;
}

const askChange = (token: string, quoteId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/staff/sales/quotes/${quoteId}/rate-change`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send({ callNote: 'He wants it on the phone.', ...body });

const decide = (token: string, requestId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/staff/sales/rate-changes/${requestId}/decide`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send(body);

const withdraw = (token: string, requestId: string) =>
  request(app)
    .post(`/api/v1/staff/sales/rate-changes/${requestId}/withdraw`)
    .set(auth(token))
    .set('Idempotency-Key', idem());

const confirm = (
  token: string,
  askId: string,
  quoteId: string,
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/v1/staff/proxy/buyer/asks/${askId}/accept`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send({
      buyerCounterpartyId,
      option: 'partial',
      quoteIds: [quoteId],
      callNote: 'He agreed.',
      ...extra,
    });

describe('Rate given → Change — ask, approve, confirm', () => {
  it('Sales asks, his leader approves, and Confirm raises the order at the approved boxes and rate', async () => {
    const { askId, quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const approvedRate = shown + 500; // The rate may go up as well as down.

    const asked = await askChange(exec.token, quoteId, {
      boxes: 6,
      ratePaise: approvedRate,
      reasonCode: 'first_order_with_buyer',
    });
    expect(asked.status).toBe(201);
    const requestId = asked.body.data.requestId as string;

    // The leader is told; the quote itself is untouched.
    expect(
      await StaffNotice.exists({ employeeId: leader.employeeId, kind: 'rate_change_requested' }),
    ).toBeTruthy();
    const quote = await Quote.findById(quoteId);
    expect(quote).toMatchObject({
      status: 'live',
      qtyAvailable: 10,
      ratePaiseForIndore: SELLER_NET,
    });

    // The file shows it waiting; only the leader can decide it.
    const asExec = await liveQuoteRow(exec.token, quoteId);
    expect(asExec.rateChange).toMatchObject({ status: 'pending', canDecide: false });
    expect((await liveQuoteRow(leader.token, quoteId)).rateChange!.canDecide).toBe(true);
    expect((await decide(exec.token, requestId, { decision: 'approved' })).status).toBe(403);

    // Confirm with it still waiting is refused, and nothing is ordered.
    const early = await confirm(exec.token, askId, quoteId, { approvalId: requestId });
    expect(early.status).toBe(400);
    expect((await Quote.findById(quoteId))!.status).toBe('live');

    expect((await decide(leader.token, requestId, { decision: 'approved' })).status).toBe(200);
    expect(
      await StaffNotice.exists({ employeeId: exec.employeeId, kind: 'rate_change_approved' }),
    ).toBeTruthy();

    const done = await confirm(exec.token, askId, quoteId, {
      approvalId: requestId,
      keepRemainderOpen: false,
    });
    expect(done.status).toBe(201);
    expect(done.body.data.soIds).toHaveLength(1);
    expect(done.body.data.filledBoxes).toBe(6);

    const line = await SoLine.findOne({ soId: done.body.data.soIds[0] });
    expect(line).toMatchObject({ boxes: 6, ratePaise: approvedRate });
    // Logged against the person who asked — not the buyer the accept runs as.
    const override = await RateOverride.findOne({ soLineId: line!._id });
    expect(override).toMatchObject({
      fromPaise: shown,
      toPaise: approvedRate,
      reasonCode: 'first_order_with_buyer',
    });
    expect(String(override!.by)).toBe(exec.employeeId);
    expect(await RateChangeRequest.findById(requestId)).toMatchObject({ status: 'used' });

    // An approval is spent once.
    const again = await confirm(exec.token, askId, quoteId, { approvalId: requestId });
    expect(again.status).toBe(400);
  });

  it('boxes only: no override, the order is at the rate he was shown, and the rest of the ask stays open', async () => {
    const { askId, quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(exec.token, quoteId, { boxes: 4, ratePaise: shown });
    expect(asked.status).toBe(201);
    expect(
      (await decide(leader.token, asked.body.data.requestId, { decision: 'approved' })).status,
    ).toBe(200);

    const done = await confirm(exec.token, askId, quoteId, {
      approvalId: asked.body.data.requestId,
    });
    expect(done.status).toBe(201);
    expect(done.body.data).toMatchObject({ filledBoxes: 4, remainingBoxes: 6 });
    const line = await SoLine.findOne({ soId: done.body.data.soIds[0] });
    expect(line).toMatchObject({ boxes: 4, ratePaise: shown });
    expect(await RateOverride.exists({ soLineId: line!._id })).toBeFalsy();
    expect(await Ask.findById(askId)).toMatchObject({ qty: 6, filledQty: 4 });
    await Ask.updateOne({ _id: askId }, { $set: { state: 'withdrawn' } }); // Keep later asks apart.
  });

  it('a lower rate is allowed too', async () => {
    const { quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(exec.token, quoteId, {
      boxes: 10,
      ratePaise: shown - 100,
      reasonCode: 'matching_competitor_quote',
    });
    expect(asked.status).toBe(201);
  });
});

describe('Rate given → Change — what is refused', () => {
  it('refuses too many boxes, a rate under the floor, a changed rate with no reason, a request that changes nothing, and a second open request', async () => {
    const { quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;

    const tooMany = await askChange(exec.token, quoteId, { boxes: 11, ratePaise: shown });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message_en).toMatch(/1 to 10/);
    expect((await askChange(exec.token, quoteId, { boxes: 0, ratePaise: shown })).status).toBe(400);

    // BR-021 — under the seller's net. The refusal never says where the floor is (BR-060).
    const low = await askChange(exec.token, quoteId, {
      boxes: 5,
      ratePaise: SELLER_NET - 1,
      reasonCode: 'clearing_slow_stock',
    });
    expect(low.status).toBe(400);
    expect(low.body.error.message_en).not.toContain(String(SELLER_NET / 100));

    const noReason = await askChange(exec.token, quoteId, { boxes: 10, ratePaise: shown + 100 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message_en).toMatch(/why the rate changes/);

    const nothing = await askChange(exec.token, quoteId, { boxes: 10, ratePaise: shown });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error.message_en).toMatch(/just Confirm/);

    expect((await askChange(exec.token, quoteId, { boxes: 5, ratePaise: shown })).status).toBe(201);
    const second = await askChange(exec.token, quoteId, { boxes: 6, ratePaise: shown });
    expect(second.status).toBe(400);
    expect(second.body.error.message_en).toMatch(/already open/);
  });

  it('refuses a rate that is no longer held', async () => {
    const { quoteId } = await liveQuote();
    await Quote.updateOne({ _id: quoteId }, { $set: { status: 'expired' } });
    const res = await askChange(exec.token, quoteId, { boxes: 5, ratePaise: SELLER_NET * 2 });
    expect(res.status).toBe(409);
  });

  it("is closed to a role without the buyer's proxy permission", async () => {
    const { quoteId } = await liveQuote();
    const purchase = await staffToken(app, 'purchase');
    expect((await askChange(purchase.token, quoteId, { boxes: 5, ratePaise: 99999 })).status).toBe(
      403,
    );
  });

  it("the buyer's own accept takes no approval, so the buyer can never name a rate or boxes", () => {
    expect(acceptAskFillSchema.safeParse({ option: 'full', quoteIds: ['q'] }).success).toBe(true);
    expect(
      acceptAskFillSchema.safeParse({ option: 'full', quoteIds: ['q'], approvalId: 'x' }).success,
    ).toBe(false);
    expect(
      acceptAskFillSchema.safeParse({ option: 'full', quoteIds: ['q'], ratePaise: 1 }).success,
    ).toBe(false);
  });
});

describe('Rate given → Change — who decides', () => {
  it('nobody approves his own request; Admin decides a leader’s; another team’s leader cannot decide', async () => {
    const { quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    // The leader asks, in his own right (the buyer sits in his team).
    const asked = await askChange(leader.token, quoteId, { boxes: 5, ratePaise: shown });
    expect(asked.status).toBe(201);
    const requestId = asked.body.data.requestId as string;

    // Told Admin, not himself.
    expect(
      await StaffNotice.exists({ employeeId: admin.employeeId, kind: 'rate_change_requested' }),
    ).toBeTruthy();
    const ownGo = await decide(leader.token, requestId, { decision: 'approved' });
    expect(ownGo.status).toBe(403);
    expect(ownGo.body.error.message_en).toMatch(/your own/);

    const other = await salesPerson('Other Leader', ['SALES_LEADER', 'SALES_EXEC'], 'self');
    expect((await decide(other.token, requestId, { decision: 'approved' })).status).toBe(403);

    expect((await decide(admin.token, requestId, { decision: 'approved' })).status).toBe(200);
  });

  it('Admin has every right: an Admin may approve their own request, and is told nothing about it', async () => {
    const { askId, quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(admin.token, quoteId, { boxes: 5, ratePaise: shown });
    expect(asked.status).toBe(201);
    const requestId = asked.body.data.requestId as string;

    // The page offers Approve (and Withdraw) to the Admin who asked.
    expect((await liveQuoteRow(admin.token, quoteId)).rateChange).toMatchObject({
      status: 'pending',
      canDecide: true,
    });
    expect((await decide(admin.token, requestId, { decision: 'approved' })).status).toBe(200);
    expect(
      await StaffNotice.exists({ employeeId: admin.employeeId, kind: 'rate_change_approved' }),
    ).toBeFalsy();

    const done = await confirm(admin.token, askId, quoteId, {
      approvalId: requestId,
      keepRemainderOpen: false,
    });
    expect(done.status).toBe(201);
    expect(done.body.data.filledBoxes).toBe(5);
  });

  it('rejecting needs a note; a rejected request cannot be confirmed, and a new one may follow', async () => {
    const { askId, quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(exec.token, quoteId, { boxes: 5, ratePaise: shown });
    const requestId = asked.body.data.requestId as string;

    expect((await decide(leader.token, requestId, { decision: 'rejected' })).status).toBe(400);
    expect(
      (await decide(leader.token, requestId, { decision: 'rejected', note: 'Too deep a cut.' }))
        .status,
    ).toBe(200);
    expect(
      await StaffNotice.exists({ employeeId: exec.employeeId, kind: 'rate_change_rejected' }),
    ).toBeTruthy();

    const row = await liveQuoteRow(exec.token, quoteId);
    expect(row.rateChange).toMatchObject({ status: 'rejected', canDecide: false });
    expect((await confirm(exec.token, askId, quoteId, { approvalId: requestId })).status).toBe(400);
    expect((await askChange(exec.token, quoteId, { boxes: 6, ratePaise: shown })).status).toBe(201);
  });

  it('an approval is for the ask and the one rate it was made for', async () => {
    const first = await liveQuote();
    const second = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, first.quoteId)).ratePaise;
    const asked = await askChange(exec.token, first.quoteId, { boxes: 5, ratePaise: shown });
    const requestId = asked.body.data.requestId as string;
    await decide(leader.token, requestId, { decision: 'approved' });

    const wrongAsk = await confirm(exec.token, second.askId, second.quoteId, {
      approvalId: requestId,
    });
    expect(wrongAsk.status).toBe(404);
    expect((await RateChangeRequest.findById(requestId))!.status).toBe('approved');
  });
});

describe('Rate given → Change — withdraw and lapse', () => {
  it('only the person who asked (or Admin) withdraws it; a withdrawn request cannot be confirmed', async () => {
    const { askId, quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(exec.token, quoteId, { boxes: 5, ratePaise: shown });
    const requestId = asked.body.data.requestId as string;
    await decide(leader.token, requestId, { decision: 'approved' });

    expect((await withdraw(leader.token, requestId)).status).toBe(403);
    expect((await withdraw(exec.token, requestId)).status).toBe(200);
    expect((await RateChangeRequest.findById(requestId))!.status).toBe('withdrawn');
    expect((await confirm(exec.token, askId, quoteId, { approvalId: requestId })).status).toBe(400);
    expect((await liveQuoteRow(exec.token, quoteId)).rateChange).toBeNull();
    expect((await withdraw(exec.token, requestId)).status).toBe(400); // Nothing left to take back.
  });

  it('the hold is not extended: once the rate is gone the request lapses and cannot be approved', async () => {
    const { quoteId } = await liveQuote();
    const shown = (await liveQuoteRow(exec.token, quoteId)).ratePaise;
    const asked = await askChange(exec.token, quoteId, { boxes: 5, ratePaise: shown });
    const requestId = asked.body.data.requestId as string;

    await Quote.updateOne({ _id: quoteId }, { $set: { status: 'expired' } });
    const late = await decide(leader.token, requestId, { decision: 'approved' });
    expect(late.status).toBe(409);
    expect((await RateChangeRequest.findById(requestId))!.status).toBe('lapsed');
  });
});
