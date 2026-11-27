import type { Request } from 'express';
import mongoose, { type ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { numberSetting } from '../../db/settings.js';
import {
  BuyerModel,
  CreditEditModel,
  CreditLineModel,
  CreditReferenceModel,
  CreditRequestModel,
  LedgerModel,
  SalesOrderModel,
  UserModel,
  VoucherModel,
} from '../../models/index.js';
import {
  CREDIT_EDIT_KINDS,
  POSITION_INFO,
  type CreditRoute,
  type StaffPosition,
} from '../../shared/enums.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { logEvent } from '../fastOrder/eventLog.js';

/**
 * Credit (reference lib/credit/*, FAST-ORDER LOCK-42 Part C).
 *
 * - `getCredit` is the only formula: limit, used (his ledger's debit balance + orders confirmed on credit and not yet
 *   billed), available, and "blocked" (a Marg bill older than its credit days still unpaid, oldest bill first).
 * - A limit is set or raised only by a request: every check is run (and shown) first; a Stop blocks it, a
 *   Controller result sends it to the Controller instead of the requester's TM. The requester never approves.
 * - Accounts changes a line (reduce, suspend, resume, days, cheque) with a reason; a second person checks it.
 * - The daily job blocks/unblocks (for the log) and suspends lines unused for CREDIT_UNUSED_DAYS. Payment reminders
 *   are not built: the reference schedules them but has no sender either.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS = {
  CREDIT_EXEC_MAX_PAISE: 10_000_000,
  CREDIT_MIN_BILLS: 5,
  CREDIT_FIRST_MULT: 2,
  CREDIT_INC_PCT: 50,
  CREDIT_INC_DAYS: 30,
  CREDIT_REJ_WAIT_DAYS: 15,
  CREDIT_REF_MAX: 5,
  CREDIT_EXEC_OVERDUE_PCT: 10,
  CREDIT_UNUSED_DAYS: 90,
  CREDIT_CHEQUE_ABOVE_PAISE: 5_000_000,
} as const;
const setting = (key: keyof typeof SETTINGS) => numberSetting(key, SETTINGS[key]);

function todayIst(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function daysBetween(fromDay: string, toDay: string) {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * The buyer's ledger, oldest first, with each debit marked paid or not (credits settle the oldest debits first, as
 * the Ledger screen's days do). Only SALES debits are bills.
 */
async function ledgerAging(buyerId: Types.ObjectId | string, session?: ClientSession | null) {
  const ledger = await LedgerModel.findOne({
    'party.side': 'BUYER',
    'party.buyerId': buyerId,
  }).session(session ?? null);
  if (!ledger)
    return { balancePaise: 0, bills: [] as { date: string; amountPaise: number; open: boolean }[] };
  const vouchers = await VoucherModel.find({ 'lines.ledgerId': ledger._id })
    .sort({ date: 1, number: 1 })
    .session(session ?? null);
  const debits: { date: string; amountPaise: number; isBill: boolean; leftPaise: number }[] = [];
  let creditPaise = 0;
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (!line.ledgerId.equals(ledger._id)) continue;
      if (line.drPaise > 0) {
        debits.push({
          date: voucher.date,
          amountPaise: line.drPaise,
          isBill: voucher.type === 'SALES',
          leftPaise: line.drPaise,
        });
      }
      creditPaise += line.crPaise;
    }
  }
  let toSettle = creditPaise;
  for (const debit of debits) {
    const used = Math.min(debit.leftPaise, toSettle);
    debit.leftPaise -= used;
    toSettle -= used;
  }
  const balancePaise = debits.reduce((sum, d) => sum + d.amountPaise, 0) - creditPaise;
  return {
    balancePaise,
    bills: debits
      .filter((d) => d.isBill)
      .map((d) => ({ date: d.date, amountPaise: d.amountPaise, open: d.leftPaise > 0 })),
  };
}

export interface CreditSnapshot {
  buyerId: string;
  hasLine: boolean;
  status: 'ACTIVE' | 'SUSPENDED' | 'NONE';
  suspendReason: 'MANUAL' | 'UNUSED' | null;
  limitPaise: number;
  usedPaise: number;
  availablePaise: number;
  usedPct: number;
  days: number;
  blocked: boolean;
  overdueDays: number;
  reference: { id: string; name: string; mobile: string } | null;
  chequeFileId: string | null;
  creditLineId: string | null;
}

/** The one credit formula (reference getCredit). */
export async function getCredit(
  buyerId: Types.ObjectId | string,
  session?: ClientSession | null,
  now = new Date(),
): Promise<CreditSnapshot> {
  const line = await CreditLineModel.findOne({ buyerId }).session(session ?? null);
  const reference = line?.referenceId
    ? await CreditReferenceModel.findById(line.referenceId).session(session ?? null)
    : null;
  const base = {
    buyerId: String(buyerId),
    reference: reference
      ? { id: reference.id, name: reference.name, mobile: reference.mobile }
      : null,
    chequeFileId: line?.chequeFileId ? String(line.chequeFileId) : null,
    creditLineId: line ? line.id : null,
  };
  if (!line || line.limitPaise <= 0) {
    return {
      ...base,
      hasLine: false,
      status: 'NONE',
      suspendReason: null,
      limitPaise: 0,
      usedPaise: 0,
      availablePaise: 0,
      usedPct: 0,
      days: line?.days ?? 0,
      blocked: false,
      overdueDays: 0,
    };
  }
  const aging = await ledgerAging(buyerId, session);
  // Orders confirmed on credit and not billed yet (once billed, the SALES voucher is on the ledger above).
  const unbilled = await SalesOrderModel.find(
    { buyerId, onCredit: true, margBill: { $exists: false }, status: { $ne: 'CANCELLED' } },
    { totalPaise: 1 },
  ).session(session ?? null);
  const usedPaise =
    Math.max(0, aging.balancePaise) + unbilled.reduce((sum, order) => sum + order.totalPaise, 0);
  const today = todayIst(now);
  let overdueDays = 0;
  for (const bill of aging.bills) {
    if (!bill.open) continue;
    const late = daysBetween(bill.date, today) - line.days;
    if (late > 0) overdueDays = Math.max(overdueDays, late);
  }
  return {
    ...base,
    hasLine: true,
    status: line.status,
    suspendReason: line.suspendReason ?? null,
    limitPaise: line.limitPaise,
    usedPaise,
    availablePaise: Math.max(0, line.limitPaise - usedPaise),
    usedPct: Math.min(100, Math.round((usedPaise / line.limitPaise) * 100)),
    days: line.days,
    blocked: overdueDays > 0,
    overdueDays,
  };
}

/** The whole "Confirm on credit" guard: a line, active, not blocked, and the WHOLE order fits (never part credit). */
export async function canConfirmOnCredit(
  buyerId: Types.ObjectId | string,
  orderValuePaise: number,
  session?: ClientSession | null,
) {
  const credit = await getCredit(buyerId, session);
  if (credit.status === 'NONE') return { ok: false, reason: 'No credit limit', credit };
  if (credit.status === 'SUSPENDED') return { ok: false, reason: 'Credit suspended', credit };
  if (credit.blocked) {
    return { ok: false, reason: `Credit blocked: bill overdue ${credit.overdueDays} days`, credit };
  }
  if (credit.availablePaise < orderValuePaise) {
    return {
      ok: false,
      reason: `Available ${formatRupees(credit.availablePaise)} is less than the order ${formatRupees(orderValuePaise)}`,
      credit,
    };
  }
  return { ok: true, reason: null, credit };
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

type CheckResult = 'ok' | 'ctl' | 'blk';
interface CheckRow {
  label: string;
  detail: string;
  result: CheckResult;
}

/** chars 3–12 of a GSTIN are the PAN: firms with the same PAN are one group. */
function panOf(gstin: string | null | undefined) {
  return gstin && gstin.length >= 12 ? gstin.slice(2, 12) : null;
}

/** Executive = junior or senior tier; TM = top. Supervisors (Founder, Admin, Controller) count as top. */
function requesterTier(
  role: string,
  position: StaffPosition | null | undefined,
): 'executive' | 'top' {
  if (role !== 'SALES') return 'top';
  return position && POSITION_INFO[position].tier === 'top' ? 'top' : 'executive';
}

export const checkInput = z.object({
  buyerId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a buyer'),
  toLimitPaise: z.number().int().min(100, 'Enter the new total limit').max(100_000_000_000),
  days: z.union([z.literal(7), z.literal(15)], { message: 'Days must be 7 or 15' }),
  referenceMobile: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Enter the reference mobile (10 digits)'),
});

/** Executive overdue % = credit used by his overdue buyers / credit used by all the buyers he brought in. */
async function executiveOverduePct(userId: string) {
  const buyers = await BuyerModel.find({ createdBy: userId });
  let outstanding = 0;
  let overdue = 0;
  for (const buyer of buyers) {
    const credit = await getCredit(buyer._id);
    outstanding += credit.usedPaise;
    if (credit.blocked) overdue += credit.usedPaise;
  }
  return outstanding > 0 ? Math.round((overdue / outstanding) * 100) : 0;
}

/**
 * Every check before a request may be sent (reference checkRequest). Nothing is saved. Returns the rows, warnings,
 * whether a Stop blocks it, and where it goes (TM or Controller).
 */
export async function checkRequest(
  input: z.output<typeof checkInput>,
  requester: { id: string; role: string; position?: StaffPosition | null },
) {
  const [
    execMax,
    minBills,
    firstMult,
    incPct,
    incDays,
    rejWait,
    refMax,
    execOverdueMax,
    chequeAbove,
  ] = await Promise.all([
    setting('CREDIT_EXEC_MAX_PAISE'),
    setting('CREDIT_MIN_BILLS'),
    setting('CREDIT_FIRST_MULT'),
    setting('CREDIT_INC_PCT'),
    setting('CREDIT_INC_DAYS'),
    setting('CREDIT_REJ_WAIT_DAYS'),
    setting('CREDIT_REF_MAX'),
    setting('CREDIT_EXEC_OVERDUE_PCT'),
    setting('CREDIT_CHEQUE_ABOVE_PAISE'),
  ]);
  const buyer = await BuyerModel.findById(input.buyerId);
  if (!buyer) throw notFound('Buyer not found.');
  const line = await CreditLineModel.findOne({ buyerId: buyer._id });
  const executive = requesterTier(requester.role, requester.position) === 'executive';
  const checks: CheckRow[] = [];
  const warnings: string[] = [];
  let blocked = false;
  // A TM's (or supervisor's) own request always goes to the Controller.
  let escalate = !executive;

  if (executive && input.toLimitPaise > execMax) {
    checks.push({
      label: 'Who can request',
      detail: `Executive can ask up to ${formatRupees(execMax)}. Above that only TM can request.`,
      result: 'blk',
    });
    blocked = true;
  } else {
    checks.push({
      label: 'Who can request',
      detail: executive ? `Executive — up to ${formatRupees(execMax)}` : 'TM — any amount',
      result: 'ok',
    });
  }

  const lastRejected = await CreditRequestModel.findOne({
    buyerId: buyer._id,
    status: 'REJECTED',
  }).sort({
    decidedAt: -1,
  });
  if (lastRejected?.decidedAt) {
    const since = Math.floor((Date.now() - lastRejected.decidedAt.getTime()) / DAY_MS);
    const wait = since < rejWait;
    checks.push({
      label: 'Last rejection',
      detail: wait ? `${since} days ago — wait ${rejWait} days` : `${since} days ago — clear`,
      result: wait ? 'blk' : 'ok',
    });
    if (wait) blocked = true;
  } else {
    checks.push({ label: 'Last rejection', detail: 'None', result: 'ok' });
  }

  const credit = await getCredit(buyer._id);
  checks.push(
    credit.blocked
      ? {
          label: 'Party overdue',
          detail: `Bill overdue ${credit.overdueDays} days — clear it first`,
          result: 'blk',
        }
      : { label: 'Party overdue', detail: 'Clear', result: 'ok' },
  );
  if (credit.blocked) blocked = true;

  const reference = await CreditReferenceModel.findOne({ mobile: input.referenceMobile });
  const otherParty = await BuyerModel.exists({
    mobiles: input.referenceMobile,
    _id: { $ne: buyer._id },
  });
  let vouchCount = 0;
  if (buyer.mobiles.includes(input.referenceMobile) || otherParty) {
    checks.push({
      label: 'Reference',
      detail: "Same as the buyer's or another party's mobile",
      result: 'blk',
    });
    blocked = true;
  } else if (!reference) {
    checks.push({
      label: 'Reference',
      detail: 'New reference — mobile not seen before',
      result: 'ok',
    });
  } else {
    vouchCount = await CreditLineModel.countDocuments({ referenceId: reference._id });
    const tooMany = vouchCount >= refMax;
    checks.push({
      label: 'Reference parties',
      detail: `${reference.name} vouches for ${vouchCount} parties${tooMany ? ` (max ${refMax})` : ''}`,
      result: tooMany ? 'ctl' : 'ok',
    });
    if (tooMany) escalate = true;
    const lines = await CreditLineModel.find({ referenceId: reference._id }, { buyerId: 1 });
    let anyOverdue = false;
    for (const other of lines) {
      if ((await getCredit(other.buyerId)).blocked) {
        anyOverdue = true;
        break;
      }
    }
    checks.push({
      label: 'Reference record',
      detail: anyOverdue ? 'A party of this reference is overdue' : 'Clean',
      result: anyOverdue ? 'ctl' : 'ok',
    });
    if (anyOverdue) escalate = true;
  }

  // Paid cash bills: Marg bills (SALES vouchers) already settled, newest first.
  const paidBills = (await ledgerAging(buyer._id)).bills.filter((bill) => !bill.open).reverse();
  if (paidBills.length < minBills) {
    checks.push({
      label: 'Paid cash bills',
      detail: `${paidBills.length} (need ${minBills})`,
      result: 'ctl',
    });
    escalate = true;
  } else {
    checks.push({ label: 'Paid cash bills', detail: `${paidBills.length}`, result: 'ok' });
  }
  const recent = paidBills.slice(0, 20);
  const avgBill = recent.length
    ? Math.round(recent.reduce((sum, bill) => sum + bill.amountPaise, 0) / recent.length)
    : 0;
  const currentLimit = line?.limitPaise ?? 0;
  if (currentLimit <= 0) {
    const suggested = avgBill * firstMult;
    const ok = avgBill === 0 || input.toLimitPaise <= suggested;
    checks.push({
      label: 'First limit vs suggested',
      detail: `${formatRupees(input.toLimitPaise)} vs ${formatRupees(suggested)} (${firstMult}× average bill ${formatRupees(avgBill)})`,
      result: ok ? 'ok' : 'ctl',
    });
    if (!ok) escalate = true;
  } else {
    const pct = ((input.toLimitPaise - currentLimit) / currentLimit) * 100;
    const ok = pct <= incPct;
    checks.push({
      label: 'Increase size',
      detail: `${formatRupees(currentLimit)} → ${formatRupees(input.toLimitPaise)} (+${pct.toFixed(0)}%, max ${incPct}%)`,
      result: ok ? 'ok' : 'ctl',
    });
    if (!ok) escalate = true;
    const lastApproved = await CreditRequestModel.findOne({
      buyerId: buyer._id,
      status: 'APPROVED',
    }).sort({ decidedAt: -1 });
    if (lastApproved?.decidedAt) {
      const since = Math.floor((Date.now() - lastApproved.decidedAt.getTime()) / DAY_MS);
      const okGap = since >= incDays;
      checks.push({
        label: 'Last increase',
        detail: `${since} days ago (min ${incDays})`,
        result: okGap ? 'ok' : 'ctl',
      });
      if (!okGap) escalate = true;
    }
  }

  const execPct = await executiveOverduePct(requester.id);
  const execOk = execPct <= execOverdueMax;
  checks.push({
    label: 'Executive record',
    detail: `${execPct}% overdue on his parties (max ${execOverdueMax}%)`,
    result: execOk ? 'ok' : 'ctl',
  });
  if (!execOk) escalate = true;

  const pan = panOf(buyer.gstin);
  if (pan) {
    const group = (await BuyerModel.find({ gstin: { $type: 'string' } }, { gstin: 1 })).filter(
      (other) => panOf(other.gstin) === pan,
    );
    if (group.length > 1) {
      let total = input.toLimitPaise;
      for (const other of group) {
        if (other._id.equals(buyer._id)) continue;
        total += (await CreditLineModel.findOne({ buyerId: other._id }))?.limitPaise ?? 0;
      }
      const ok = total <= execMax;
      checks.push({
        label: 'Group (same PAN)',
        detail: `${group.length} firms → combined ${formatRupees(total)}`,
        result: ok ? 'ok' : 'ctl',
      });
      if (!ok) escalate = true;
    }
  }

  const sameAddress = await BuyerModel.findOne({ address: buyer.address, _id: { $ne: buyer._id } });
  if (sameAddress) warnings.push(`Same address as another party (${sameAddress.firmName})`);

  const route: CreditRoute = executive && !escalate ? 'TM' : 'CONTROLLER';
  return {
    checks,
    warnings,
    blocked,
    route,
    cheque: input.toLimitPaise > chequeAbove,
    snapshot: {
      partyName: buyer.firmName,
      paidBills: paidBills.length,
      avgBillPaise: avgBill,
      suggestedLimitPaise: avgBill * firstMult,
      overdueDays: credit.overdueDays,
      referenceName: reference?.name ?? null,
      referencePartyCount: vouchCount,
      requesterOverduePct: execPct,
      currentLimitPaise: currentLimit,
    },
  };
}

export const requestInput = checkInput.extend({
  referenceName: z.string().trim().min(1, 'Reference name is required').max(120),
  referenceNote: z.string().trim().max(300).optional(),
  note: z.string().trim().max(300).optional(),
  chequeFileId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
});

/** Who is asking, with the rule that a Sales person needs a Sales position (Jr/Sr Executive or TM). */
async function requesterOf(req: Request) {
  const me = currentUserOf(req);
  const user = await UserModel.findById(me.id).orFail();
  const position: StaffPosition | null = user.position ?? null;
  if (me.role === 'SALES' && (!position || POSITION_INFO[position].department !== 'SALES')) {
    throw invalidField(
      'position',
      'A Sales position (Jr/Sr Executive or TM) is required to request credit',
    );
  }
  return { id: me.id, role: me.role, position };
}

export async function runCheck(req: Request, input: z.output<typeof checkInput>) {
  return checkRequest(input, await requesterOf(req));
}

/** Sends the request if no check says Stop. One reference per mobile (its first name is kept). */
export async function createRequest(req: Request, input: z.output<typeof requestInput>) {
  const requester = await requesterOf(req);
  const result = await checkRequest(input, requester);
  if (result.blocked) {
    const stop = result.checks.find((row) => row.result === 'blk');
    throw conflict(`Cannot send: ${stop?.detail ?? 'a check failed'}`, 'CREDIT_CHECK_STOP');
  }
  return mongoose.connection.transaction(async (session) => {
    const reference = await CreditReferenceModel.findOneAndUpdate(
      { mobile: input.referenceMobile },
      {
        $setOnInsert: {
          name: input.referenceName,
          mobile: input.referenceMobile,
          ...(input.referenceNote ? { note: input.referenceNote } : {}),
          createdBy: requester.id,
        },
      },
      { upsert: true, returnDocument: 'after', session },
    ).orFail();
    const line = await CreditLineModel.findOne({ buyerId: input.buyerId }).session(session);
    const [request] = await CreditRequestModel.create(
      [
        {
          number: await nextDocumentNumber('CR', { session }),
          buyerId: input.buyerId,
          fromLimitPaise: line?.limitPaise ?? 0,
          toLimitPaise: input.toLimitPaise,
          days: input.days,
          referenceId: reference._id,
          ...(input.note ? { note: input.note } : {}),
          ...(input.chequeFileId ? { chequeFileId: input.chequeFileId } : {}),
          requestedBy: requester.id,
          ...(requester.position ? { requestedPosition: requester.position } : {}),
          route: result.route,
          checks: result.checks,
          warnings: result.warnings,
          snapshot: result.snapshot,
        },
      ],
      { session },
    );
    await logEvent(
      {
        category: 'CREDIT',
        entityType: 'CreditRequest',
        entityId: request!._id,
        partyId: input.buyerId,
        action: 'REQUEST_CREATED',
        userId: requester.id,
        newValue: {
          number: request!.number,
          toLimitPaise: input.toLimitPaise,
          route: result.route,
        },
      },
      session,
    );
    return request!;
  });
}

/** May this person decide this request? Never the requester; TM route: his TM (or Controller/Founder/Admin). */
async function assertCanDecide(
  request: { requestedBy: Types.ObjectId; route: CreditRoute },
  actor: { id: string; role: string },
) {
  if (request.requestedBy.equals(actor.id)) {
    throw forbidden('The requester cannot approve his own request — maker is not checker');
  }
  if (actor.role === 'FOUNDER' || actor.role === 'ADMIN') return;
  if (request.route === 'CONTROLLER') {
    if (actor.role !== 'CONTROLLER') {
      throw forbidden('Only the Controller (or Founder) may approve a Controller-route request');
    }
    return;
  }
  if (actor.role === 'CONTROLLER') return;
  const user = await UserModel.findById(actor.id);
  if (user?.position !== 'TM')
    throw forbidden('Only the TM (or Controller/Founder) may approve this request');
  const requester = await UserModel.findById(request.requestedBy);
  if (requester?.position && String(requester.reportsToId) !== actor.id) {
    throw forbidden('A TM may approve only requests from his own team');
  }
}

async function openRequest(id: string) {
  const request = Types.ObjectId.isValid(id) ? await CreditRequestModel.findById(id) : null;
  if (!request) throw notFound('Request not found.');
  if (request.status !== 'OPEN') throw conflict('This request has already been decided', 'DECIDED');
  return request;
}

/** Approve: the line is set (or raised) to the request's limit and days, and is active again. */
export async function approveRequest(req: Request, id: string) {
  const actor = currentUserOf(req);
  const request = await openRequest(id);
  await assertCanDecide(request, actor);
  return mongoose.connection.transaction(async (session) => {
    const now = new Date();
    const existing = await CreditLineModel.findOne({ buyerId: request.buyerId }).session(session);
    await CreditLineModel.updateOne(
      { buyerId: request.buyerId },
      {
        $set: {
          limitPaise: request.toLimitPaise,
          days: request.days,
          status: 'ACTIVE',
          referenceId: request.referenceId,
          approvedRequestId: request._id,
          ...(request.chequeFileId ? { chequeFileId: request.chequeFileId } : {}),
          ...(existing ? {} : { lastUsedAt: now }),
        },
        $unset: { suspendReason: 1 },
      },
      { upsert: true, session },
    );
    request.set({ status: 'APPROVED', decidedBy: actor.id, decidedAt: now });
    await request.save({ session });
    await logEvent(
      {
        category: 'CREDIT',
        entityType: 'CreditRequest',
        entityId: request._id,
        partyId: request.buyerId,
        action: 'REQUEST_APPROVED',
        userId: actor.id,
        oldValue: { limitPaise: request.fromLimitPaise },
        newValue: { limitPaise: request.toLimitPaise, days: request.days },
      },
      session,
    );
    return request;
  });
}

export async function rejectRequest(req: Request, id: string, reason: string) {
  const actor = currentUserOf(req);
  if (!reason.trim()) throw invalidField('reason', 'A reason is required');
  const request = await openRequest(id);
  await assertCanDecide(request, actor);
  request.set({
    status: 'REJECTED',
    decidedBy: actor.id,
    decidedAt: new Date(),
    decisionReason: reason,
  });
  await request.save();
  await logEvent({
    category: 'CREDIT',
    entityType: 'CreditRequest',
    entityId: request._id,
    partyId: request.buyerId,
    action: 'REQUEST_REJECTED',
    userId: actor.id,
    reason,
  });
  return request;
}

/** The open requests this person may decide now (reference scope=toApprove). */
export async function requestsToApprove(req: Request) {
  const me = currentUserOf(req);
  if (['FOUNDER', 'ADMIN', 'CONTROLLER'].includes(me.role)) {
    return CreditRequestModel.find({ status: 'OPEN' }).sort({ createdAt: 1 });
  }
  const user = await UserModel.findById(me.id);
  if (user?.position !== 'TM') return [];
  const team = await UserModel.find({ reportsToId: me.id });
  return CreditRequestModel.find({
    status: 'OPEN',
    route: 'TM',
    requestedBy: { $in: team.map((member) => member._id) },
  }).sort({ createdAt: 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts edits

export const editInput = z.object({
  buyerId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a buyer'),
  kind: z.enum(CREDIT_EDIT_KINDS),
  newValue: z.string().trim().max(200).default(''),
  reason: z.string().trim().min(1, 'A reason is required').max(300),
});

/**
 * Accounts proposes a change to a line, with a reason. REDUCE takes rupees (it must be lower), DAYS 7 or 15, CHEQUE
 * an uploaded file id. An increase is never done here.
 */
export async function proposeEdit(req: Request, input: z.output<typeof editInput>) {
  const me = currentUserOf(req);
  const line = await CreditLineModel.findOne({ buyerId: input.buyerId });
  if (!line) throw invalidField('buyerId', 'This party has no credit line yet');
  let oldValue: string;
  let newValue = input.newValue;
  if (input.kind === 'REDUCE') {
    oldValue = String(line.limitPaise);
    const paise = Math.round(Number(input.newValue) * 100);
    if (!Number.isFinite(paise) || paise < 0 || paise >= line.limitPaise) {
      throw invalidField(
        'newValue',
        'Increase is never done here — only through a request. Reduce must be a lower amount.',
      );
    }
    newValue = String(paise);
  } else if (input.kind === 'SUSPEND') {
    oldValue = line.status;
    if (line.status === 'SUSPENDED') throw conflict('Already suspended', 'ALREADY_SUSPENDED');
    newValue = 'SUSPENDED';
  } else if (input.kind === 'RESUME') {
    oldValue = line.status;
    if (line.status !== 'SUSPENDED') throw conflict('Not suspended', 'NOT_SUSPENDED');
    if (line.suspendReason !== 'MANUAL') {
      throw invalidField(
        'kind',
        'Only a manual suspension can be resumed here — an unused suspension restarts only via a new request',
      );
    }
    newValue = 'ACTIVE';
  } else if (input.kind === 'DAYS') {
    oldValue = String(line.days);
    if (input.newValue !== '7' && input.newValue !== '15') {
      throw invalidField('newValue', 'Days must be 7 or 15');
    }
  } else {
    oldValue = line.chequeFileId ? String(line.chequeFileId) : '';
    if (!/^[a-f0-9]{24}$/.test(input.newValue)) {
      throw invalidField('newValue', 'Upload the cheque or agreement photo');
    }
  }
  const edit = await CreditEditModel.create({
    buyerId: input.buyerId,
    kind: input.kind,
    oldValue,
    newValue,
    reason: input.reason,
    madeBy: me.id,
  });
  await logEvent({
    category: 'CREDIT',
    entityType: 'CreditEdit',
    entityId: edit._id,
    partyId: input.buyerId,
    action: 'EDIT_PROPOSED',
    userId: me.id,
    oldValue,
    newValue: { kind: input.kind, value: newValue },
    reason: input.reason,
  });
  return edit;
}

/** A second person applies or rejects the edit (never the one who made it). */
export async function checkEdit(req: Request, id: string, apply: boolean) {
  const me = currentUserOf(req);
  const edit = Types.ObjectId.isValid(id) ? await CreditEditModel.findById(id) : null;
  if (!edit) throw notFound('Edit not found.');
  if (edit.status !== 'PENDING') throw conflict('This edit has already been checked', 'CHECKED');
  if (edit.madeBy.equals(me.id)) {
    throw forbidden('The person who proposed this edit cannot check it — maker is not checker');
  }
  return mongoose.connection.transaction(async (session) => {
    if (apply) {
      const update =
        edit.kind === 'REDUCE'
          ? { $set: { limitPaise: Number(edit.newValue) } }
          : edit.kind === 'SUSPEND'
            ? { $set: { status: 'SUSPENDED', suspendReason: 'MANUAL' } }
            : edit.kind === 'RESUME'
              ? { $set: { status: 'ACTIVE' }, $unset: { suspendReason: 1 } }
              : edit.kind === 'DAYS'
                ? { $set: { days: Number(edit.newValue) } }
                : { $set: { chequeFileId: edit.newValue } };
      await CreditLineModel.updateOne({ buyerId: edit.buyerId }, update, { session });
    }
    edit.set({ status: apply ? 'APPLIED' : 'REJECTED', checkedBy: me.id, checkedAt: new Date() });
    await edit.save({ session });
    await logEvent(
      {
        category: 'CREDIT',
        entityType: 'CreditEdit',
        entityId: edit._id,
        partyId: edit.buyerId,
        action: apply ? 'EDIT_APPLIED' : 'EDIT_REJECTED',
        userId: me.id,
        newValue: { kind: edit.kind, value: edit.newValue },
      },
      session,
    );
    if (apply && (edit.kind === 'SUSPEND' || edit.kind === 'RESUME')) {
      await logEvent(
        {
          category: 'CREDIT',
          entityType: 'CreditLine',
          entityId: edit.buyerId,
          partyId: edit.buyerId,
          action: edit.kind === 'SUSPEND' ? 'SUSPENDED' : 'RESUMED',
          userId: me.id,
        },
        session,
      );
    }
    return edit;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The daily job and the Controller's summaries

/** Block/unblock (for the log) and suspend lines unused for CREDIT_UNUSED_DAYS. Returns what changed. */
export async function runDailyCreditJob(now = new Date()) {
  const unusedDays = await setting('CREDIT_UNUSED_DAYS');
  let blocked = 0;
  let unblocked = 0;
  let suspended = 0;
  for (const line of await CreditLineModel.find({ status: 'ACTIVE' })) {
    const credit = await getCredit(line.buyerId, null, now);
    if (credit.blocked && !line.blockedSince) {
      await CreditLineModel.updateOne({ _id: line._id }, { $set: { blockedSince: now } });
      await logEvent({
        category: 'CREDIT',
        entityType: 'CreditLine',
        entityId: line.buyerId,
        partyId: line.buyerId,
        action: 'AUTO_BLOCKED',
        newValue: { overdueDays: credit.overdueDays },
      });
      blocked++;
    } else if (!credit.blocked && line.blockedSince) {
      await CreditLineModel.updateOne({ _id: line._id }, { $unset: { blockedSince: 1 } });
      await logEvent({
        category: 'CREDIT',
        entityType: 'CreditLine',
        entityId: line.buyerId,
        partyId: line.buyerId,
        action: 'AUTO_UNBLOCKED',
      });
      unblocked++;
    }
    const lastActivity = line.lastUsedAt ?? line.get('createdAt');
    const idleDays = Math.floor((now.getTime() - lastActivity.getTime()) / DAY_MS);
    if (line.limitPaise > 0 && idleDays >= unusedDays) {
      await CreditLineModel.updateOne(
        { _id: line._id },
        { $set: { status: 'SUSPENDED', suspendReason: 'UNUSED' } },
      );
      await logEvent({
        category: 'CREDIT',
        entityType: 'CreditLine',
        entityId: line.buyerId,
        partyId: line.buyerId,
        action: 'AUTO_SUSPENDED_UNUSED',
        newValue: { idleDays },
      });
      suspended++;
    }
  }
  return { blocked, unblocked, suspended };
}

/** Exposure by executive (who brought the buyer in) and by reference: credit used, biggest first. */
export async function exposureSummaries() {
  const lines = await CreditLineModel.find({ limitPaise: { $gt: 0 } });
  const byExecutive = new Map<string, number>();
  const byReference = new Map<string, number>();
  const buyers = await BuyerModel.find(
    { _id: { $in: lines.map((l) => l.buyerId) } },
    { createdBy: 1 },
  );
  const users = await UserModel.find({
    _id: { $in: buyers.flatMap((b) => (b.createdBy ? [b.createdBy] : [])) },
  });
  const references = await CreditReferenceModel.find({
    _id: { $in: lines.flatMap((l) => (l.referenceId ? [l.referenceId] : [])) },
  });
  for (const line of lines) {
    const used = (await getCredit(line.buyerId)).usedPaise;
    if (used <= 0) continue;
    const buyer = buyers.find((b) => b._id.equals(line.buyerId));
    const executive =
      users.find((u) => buyer?.createdBy && u._id.equals(buyer.createdBy))?.name ?? '—';
    byExecutive.set(executive, (byExecutive.get(executive) ?? 0) + used);
    const reference =
      references.find((r) => line.referenceId && r._id.equals(line.referenceId))?.name ?? '—';
    byReference.set(reference, (byReference.get(reference) ?? 0) + used);
  }
  const rows = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, usedPaise]) => ({ name, usedPaise }));
  return { byExecutive: rows(byExecutive), byReference: rows(byReference) };
}

/** For the today pages and lists: a request as screens show it. */
export async function requestViews(requests: InstanceType<typeof CreditRequestModel>[]) {
  const [buyers, references, users] = await Promise.all([
    BuyerModel.find({ _id: { $in: requests.map((r) => r.buyerId) } }, { firmName: 1, number: 1 }),
    CreditReferenceModel.find({ _id: { $in: requests.map((r) => r.referenceId) } }),
    UserModel.find({ _id: { $in: requests.map((r) => r.requestedBy) } }, { name: 1 }),
  ]);
  return requests.map((request) => ({
    id: request.id,
    number: request.number,
    party: {
      id: String(request.buyerId),
      name: buyers.find((b) => b._id.equals(request.buyerId))?.firmName ?? '',
    },
    fromLimitPaise: request.fromLimitPaise,
    toLimitPaise: request.toLimitPaise,
    days: request.days,
    reference: (() => {
      const ref = references.find((r) => r._id.equals(request.referenceId));
      return { name: ref?.name ?? '', mobile: ref?.mobile ?? '' };
    })(),
    route: request.route,
    checks: request.checks.map((c) => ({ label: c.label, detail: c.detail, result: c.result })),
    warnings: request.warnings,
    status: request.status,
    requestedBy: users.find((u) => u._id.equals(request.requestedBy))?.name ?? '',
    requestedPosition: request.requestedPosition ?? null,
    decisionReason: request.decisionReason ?? null,
    createdAt: request.createdAt,
  }));
}
