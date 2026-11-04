import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Ask } from '../src/models/Ask.js';
import { BookAssignment } from '../src/models/BookAssignment.js';
import { Buyer } from '../src/models/Buyer.js';
import { Employee } from '../src/models/Employee.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { RateChangeRequest } from '../src/models/RateChangeRequest.js';
import { RateOverride } from '../src/models/RateOverride.js';
import { Role } from '../src/models/Role.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { SoLine } from '../src/models/SoLine.js';
import * as demandService from '../src/modules/demand/demand.service.js';
import { runConfirmPileFanout } from '../src/modules/demand/pileFanout.job.js';
import { createListing, createPileRequest } from '../src/modules/listing/listing.service.js';
import { loginStaff, randomEmail, randomMobile } from './helpers.js';
import { salesLeader } from './buyerHelpers.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/**
 * 4 Nov — Rate given → Change on a pile deal (BR-378 + BR-379). The seller confirmed 10 boxes for
 * him; Sales may ask for fewer and/or another rate, his Sales Leader approves, and Confirm raises the
 * order at the approved figures — the boxes he does not take go back on the seller's listing.
 */

const app = createApp();
const SELLER_NET = 40000;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => randomUUID();

type Staff = { token: string; employeeId: string };
let admin: Staff;
let purchase: Staff;
let registrar: Staff;
let leader: Staff;
let exec: Staff;

async function salesExec(): Promise<Staff> {
  const roles = await Role.find({ key: 'sales' });
  const password = 'CorrectHorse123';
  const email = randomEmail();
  const employee = await Employee.create({
    person: 'Test Sales Exec',
    email,
    mobile: randomMobile(),
    passwordHash: await bcrypt.hash(password, 10),
    roleIds: roles.map((r) => r._id),
    positions: ['SALES_EXEC'],
    reportsToSalesLeaderId: leader.employeeId,
    active: true,
  });
  return { token: await loginStaff(app, email, password), employeeId: String(employee._id) };
}

beforeAll(async () => {
  admin = await staffToken(app, 'admin');
  purchase = await staffToken(app, 'purchase');
  registrar = await staffToken(app, 'sales');
  leader = await salesLeader(app);
  exec = await salesExec();
  for (const tier of ['Distributor', 'Dealer', 'Retailer', 'Trader'] as const) {
    await seedMarginCell('Medium', tier, 0.02, admin.employeeId);
  }
}, 60000);

interface World {
  lineId: string;
  pileId: string;
  buyerDocId: string;
  buyerCp: string;
  requestId: string; // The deal given to the first buyer: 10 boxes.
}

/** A line of 30 boxes; two buyers ask 10 and 5; the seller confirms the 15 and the fan-out runs. */
async function offeredDeal(): Promise<World> {
  const tehsil = await createTehsil();
  const skuId = await createTestSku('Medium');
  const sellerDocId = await createApprovedSellerAtTehsils(app, purchase.token, [tehsil]);
  const sellerCp = String((await Seller.findById(sellerDocId))!.counterpartyId);
  const buyers: Array<{ docId: string; cp: string }> = [];
  for (let i = 0; i < 2; i += 1) {
    const docId = await createApprovedBuyerAtTehsil(app, registrar.token, tehsil, 'dealer');
    buyers.push({ docId, cp: String((await Buyer.findById(docId))!.counterpartyId) });
    // His book belongs to the executive, who sits in the leader's team.
    await BookAssignment.updateOne(
      { buyerId: docId },
      { $set: { ownerEmployeeId: exec.employeeId } },
    );
  }
  await createListing(sellerCp, {
    productId: String((await Sku.findById(skuId))!.productId),
    scopeType: 'my_area',
    lines: [
      {
        skuId,
        ratePaise: SELLER_NET,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '48h',
        provenance: 'company',
        qty: 30,
      },
    ],
  } as never);
  const lineId = String((await ListingLine.findOne({ skuId }))!._id);
  let pileId = '';
  for (const [i, qty] of [10, 5].entries()) {
    pileId = (await createPileRequest(buyers[i]!.cp, lineId, { qty })).pileId;
  }
  await demandService.confirmPile(
    sellerCp,
    pileId,
    { canSendBoxes: 15, expiryExact: '2029' },
    randomUUID(),
  );
  await runConfirmPileFanout(pileId);
  const requests = await PileRequest.find({ pileId }).sort({ requestedAt: 1 });
  return {
    lineId,
    pileId,
    buyerDocId: buyers[0]!.docId,
    buyerCp: buyers[0]!.cp,
    requestId: String(requests[0]!._id),
  };
}

interface FileDeal {
  requestId: string;
  ratePaise: number | null;
  rateChange: { requestId: string; status: string; canDecide: boolean } | null;
}
async function dealRow(token: string, w: World): Promise<FileDeal> {
  const file = await request(app)
    .get(`/api/v1/staff/sales/buyers/${w.buyerDocId}`)
    .set(auth(token));
  expect(file.status).toBe(200);
  return (file.body.data.pileOffers as FileDeal[]).find((o) => o.requestId === w.requestId)!;
}

const askChange = (token: string, w: World, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/staff/sales/pile-offers/${w.requestId}/rate-change`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send({ callNote: 'He wants fewer on the phone.', ...body });

const decide = (token: string, requestId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/staff/sales/rate-changes/${requestId}/decide`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send(body);

const confirm = (token: string, w: World, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/v1/staff/proxy/buyer/pile-offers/${w.requestId}/accept`)
    .set(auth(token))
    .set('Idempotency-Key', idem())
    .send({ buyerCounterpartyId: w.buyerCp, callNote: 'He agreed.', ...extra });

describe('Rate given → Change on a pile deal', () => {
  it('asks, is approved, and Confirm raises the order at the approved boxes and rate; the rest go back on the listing', async () => {
    const w = await offeredDeal();
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(15); // 30 less the 15 held.
    const shown = (await dealRow(exec.token, w)).ratePaise!;
    const approvedRate = shown + 300;

    const asked = await askChange(exec.token, w, {
      boxes: 6,
      ratePaise: approvedRate,
      reasonCode: 'first_order_with_buyer',
    });
    expect(asked.status).toBe(201);
    const approvalId = asked.body.data.requestId as string;

    // Waiting: only the leader can decide it; Confirm with it is refused; nothing is ordered.
    expect(await dealRow(exec.token, w)).toMatchObject({
      rateChange: { status: 'pending', canDecide: false },
    });
    expect((await dealRow(leader.token, w)).rateChange!.canDecide).toBe(true);
    expect((await decide(exec.token, approvalId, { decision: 'approved' })).status).toBe(403);
    expect((await confirm(exec.token, w, { approvalId })).status).toBe(400);
    expect((await PileRequest.findById(w.requestId))!.offerState).toBe('offered');

    expect((await decide(leader.token, approvalId, { decision: 'approved' })).status).toBe(200);
    const done = await confirm(exec.token, w, { approvalId });
    expect(done.status).toBe(201);
    expect(done.body.data.boxes).toBe(6);

    const line = await SoLine.findOne({ soId: done.body.data.soId });
    expect(line).toMatchObject({ boxes: 6, ratePaise: approvedRate });
    const override = await RateOverride.findOne({ soLineId: line!._id });
    expect(override).toMatchObject({
      fromPaise: shown,
      toPaise: approvedRate,
      reasonCode: 'first_order_with_buyer',
    });
    expect(String(override!.by)).toBe(exec.employeeId);

    // The 4 he did not take are back on the seller's listing; no ask is raised for them.
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(19);
    expect(await Ask.countDocuments({ buyerId: w.buyerDocId })).toBe(0);
    expect((await PileRequest.findById(w.requestId))!.offerState).toBe('ordered');
    expect(await RateChangeRequest.findById(approvalId)).toMatchObject({ status: 'used' });

    // An approval is spent once.
    expect((await confirm(exec.token, w, { approvalId })).status).toBeGreaterThanOrEqual(400);
  });

  it('boxes only: no override, the order is at his rate, and the rest go back', async () => {
    const w = await offeredDeal();
    const shown = (await dealRow(exec.token, w)).ratePaise!;
    const asked = await askChange(exec.token, w, { boxes: 7, ratePaise: shown });
    expect(asked.status).toBe(201);
    const approvalId = asked.body.data.requestId as string;
    await decide(leader.token, approvalId, { decision: 'approved' });

    const done = await confirm(exec.token, w, { approvalId });
    expect(done.status).toBe(201);
    const line = await SoLine.findOne({ soId: done.body.data.soId });
    expect(line).toMatchObject({ boxes: 7, ratePaise: shown });
    expect(await RateOverride.exists({ soLineId: line!._id })).toBeFalsy();
    expect((await ListingLine.findById(w.lineId))!.qty).toBe(18); // 15 + the 3 not taken.
  });

  it('refuses more boxes than the seller confirmed, a rate under the floor, a change with no reason, no change at all, and a second open request', async () => {
    const w = await offeredDeal();
    const shown = (await dealRow(exec.token, w)).ratePaise!;

    const tooMany = await askChange(exec.token, w, { boxes: 11, ratePaise: shown });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message_en).toMatch(/1 to 10/);

    const low = await askChange(exec.token, w, {
      boxes: 5,
      ratePaise: SELLER_NET - 1,
      reasonCode: 'clearing_slow_stock',
    });
    expect(low.status).toBe(400);
    expect(low.body.error.message_en).not.toContain(String(SELLER_NET / 100));

    expect((await askChange(exec.token, w, { boxes: 10, ratePaise: shown + 100 })).status).toBe(
      400,
    );
    expect((await askChange(exec.token, w, { boxes: 10, ratePaise: shown })).status).toBe(400);

    expect((await askChange(exec.token, w, { boxes: 5, ratePaise: shown })).status).toBe(201);
    const second = await askChange(exec.token, w, { boxes: 6, ratePaise: shown });
    expect(second.status).toBe(400);
    expect(second.body.error.message_en).toMatch(/already open/);
  });

  it('lapses with the deal: walked away from, or past its hold', async () => {
    const w = await offeredDeal();
    const shown = (await dealRow(exec.token, w)).ratePaise!;
    const asked = await askChange(exec.token, w, { boxes: 5, ratePaise: shown });
    const approvalId = asked.body.data.requestId as string;

    const away = await request(app)
      .post(`/api/v1/staff/proxy/buyer/pile-offers/${w.requestId}/decline`)
      .set(auth(exec.token))
      .set('Idempotency-Key', idem())
      .send({ buyerCounterpartyId: w.buyerCp, callNote: 'Not now.' });
    expect(away.status).toBe(200);
    const late = await decide(leader.token, approvalId, { decision: 'approved' });
    expect(late.status).toBe(409);
    expect((await RateChangeRequest.findById(approvalId))!.status).toBe('lapsed');

    // Past its hold, a new request is refused outright.
    const second = await offeredDeal();
    await PileRequest.updateOne(
      { _id: second.requestId },
      { $set: { holdUntil: new Date(Date.now() - 1000) } },
    );
    expect((await askChange(exec.token, second, { boxes: 5, ratePaise: 99999 })).status).toBe(409);
  });

  it('an approval is for the one deal; and a role without the buyer proxy permission cannot ask', async () => {
    const first = await offeredDeal();
    const second = await offeredDeal();
    const shown = (await dealRow(exec.token, first)).ratePaise!;
    const asked = await askChange(exec.token, first, { boxes: 5, ratePaise: shown });
    const approvalId = asked.body.data.requestId as string;
    await decide(leader.token, approvalId, { decision: 'approved' });

    expect((await confirm(exec.token, second, { approvalId })).status).toBe(404);
    expect((await RateChangeRequest.findById(approvalId))!.status).toBe('approved');
    expect((await askChange(purchase.token, first, { boxes: 5, ratePaise: shown })).status).toBe(
      403,
    );
  });
});
