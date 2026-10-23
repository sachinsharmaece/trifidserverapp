import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { SellerPush, type SellerPushDocument } from '../../models/SellerPush.js';
import { SellerReference } from '../../models/SellerReference.js';
import { SellerDealership } from '../../models/SellerDealership.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerAssignment } from '../../models/SellerAssignment.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { BankDetail } from '../../models/BankDetail.js';
import { Manufacturer } from '../../models/Manufacturer.js';
import { Employee } from '../../models/Employee.js';
import { Tehsil } from '../../models/Tehsil.js';
import { District } from '../../models/District.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { encryptAccountNumber } from '../../shared/encryption.js';
import { panFromGstin } from '../../shared/validators.js';
import {
  assertMayAssign,
  callerCovers,
  isLeaderOf,
  leaderOf,
  teamOf,
  type StaffCaller,
} from '../../shared/team.js';
import { assertLocationChain, recordPincodeIfUnknown } from '../territory/territory.masters.js';
import { assertGstinState, assertSellerMargCodeFree } from '../onboarding/seller.registration.js';
import { notifyStaff } from '../notice/notice.service.js';
import type {
  ApprovePushInput,
  CompletePushInput,
  CreatePushInput,
  ListPushesQuery,
} from './push.validation.js';

/**
 * Phase 6 — Push to Purchase (BR-363–BR-366). A buyer who can also supply is
 * pushed by Sales to the purchase executive of his team (the team's Sales
 * Leader, DEC-059), completed on the first call, and approved by a Purchase
 * Leader — at which point a seller profile is added to his own firm record.
 *
 * The wall: Purchase reads the firm's identity, "Pushed by" and the note;
 * Sales reads the status and the Purchase person's name. Neither sees the
 * other side's trade (orders, rates, asks, calls / listings, catalogue).
 */
export interface Actor extends StaffCaller {
  correlationId: string;
}

const id = (value: unknown): string => String(value);
const isAdmin = (caller: StaffCaller, side: 'sales' | 'purchase') =>
  caller.permissions.includes(
    side === 'sales' ? PERMISSIONS.BUYER_ADMIN : PERMISSIONS.SELLER_ADMIN,
  );
const fail = (messageEn: string, field?: string, meta?: Record<string, unknown>) =>
  new AppError({ code: 'VALIDATION_FAILED', messageEn, field, meta });

async function personOf(employeeId: unknown): Promise<string | null> {
  if (!employeeId) return null;
  return (await Employee.findById(employeeId, { person: 1 }))?.person ?? null;
}

async function buyerOwner(buyerId: unknown): Promise<string | null> {
  const assignment = await BookAssignment.findOne({ buyerId }, { ownerEmployeeId: 1 });
  return assignment ? id(assignment.ownerEmployeeId) : null;
}

/**
 * The Sales Leader of the buyer's team: his executive's leader (a leader
 * owning him himself); for a buyer in the Queue, the pusher's own leader.
 */
async function buyerTeamLeader(buyerId: unknown, pusherId: string): Promise<string | null> {
  const owner = await buyerOwner(buyerId);
  return leaderOf('sales', owner ?? pusherId);
}

/** Someone who can receive a push: active, holding the Purchase Exec position. */
async function assertReceiver(employeeId: string, field = 'receiverEmployeeId') {
  const employee = await Employee.findOne(
    { _id: employeeId, active: true, positions: 'PURCHASE_EXEC' },
    { person: 1 },
  );
  if (!employee) throw fail('Pick an active Purchase executive.', field);
  return employee;
}

// ---------------------------------------------------------------------------
// Sales — the button
// ---------------------------------------------------------------------------

export interface PushStatusDto {
  canPush: boolean;
  /** Why the button is off, in words; null when it is on. */
  blockedReason: string | null;
  alreadySeller: { sellerId: string; firm: string } | null;
  openPush: { pushId: string; status: string; receiver: string | null } | null;
  /** Where it goes: the Sales Leader of his team, acting as its purchase executive. */
  receiver: { employeeId: string; person: string } | null;
  /** Admin may send it to any Purchase executive instead. */
  canChooseReceiver: boolean;
}

async function existingSellerFor(counterparty: {
  _id: unknown;
  gstin?: string | null;
  pan?: string | null;
}): Promise<{ sellerId: string; firm: string } | null> {
  const own = await Seller.findOne({ counterpartyId: counterparty._id }, { _id: 1 });
  if (own) {
    const cp = await Counterparty.findById(counterparty._id, { firm: 1 });
    return { sellerId: id(own._id), firm: cp?.firm ?? '' };
  }
  // A PAN-only buyer whose PAN sits inside a seller's GSTIN is that seller.
  if (!counterparty.gstin && counterparty.pan) {
    const candidates = await Counterparty.find(
      { gstin: { $regex: `^\\d{2}${counterparty.pan}` }, _id: { $ne: counterparty._id } },
      { firm: 1 },
    );
    for (const candidate of candidates) {
      const seller = await Seller.findOne({ counterpartyId: candidate._id }, { _id: 1 });
      if (seller) return { sellerId: id(seller._id), firm: candidate.firm ?? '' };
    }
  }
  return null;
}

export async function getPushStatus(buyerId: string, caller: StaffCaller): Promise<PushStatusDto> {
  const buyer = await Buyer.findById(buyerId);
  if (!buyer) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
  const counterparty = await Counterparty.findById(buyer.counterpartyId);
  if (!counterparty) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });

  const owner = await buyerOwner(buyer._id);
  const covers = await callerCovers('sales', caller, owner, { queueAllowed: true });
  const alreadySeller = await existingSellerFor(counterparty);
  const open = await SellerPush.findOne({ counterpartyId: counterparty._id, open: true });
  const receiverId = await buyerTeamLeader(buyer._id, caller.employeeId);
  const receiverPerson = receiverId ? await personOf(receiverId) : null;
  const canChooseReceiver = isAdmin(caller, 'sales');

  let blockedReason: string | null = null;
  if (!covers)
    blockedReason = "Only his executive, that executive's leader, or Admin can push him.";
  else if (alreadySeller) blockedReason = 'Already a seller.';
  else if (open) {
    blockedReason = `A push is already ${open.status === 'pending' ? 'pending' : 'waiting for approval'}.`;
  } else if (counterparty.status !== 'active') {
    blockedReason = 'Push him once his buyer registration is approved.';
  } else if (!receiverPerson && !canChooseReceiver) {
    blockedReason = 'His team has no Sales Leader to receive it — ask Admin to send it.';
  }

  return {
    canPush: blockedReason === null,
    blockedReason,
    alreadySeller,
    openPush: open
      ? {
          pushId: id(open._id),
          status: open.status,
          receiver: await personOf(open.receiverEmployeeId),
        }
      : null,
    receiver:
      receiverId && receiverPerson ? { employeeId: receiverId, person: receiverPerson } : null,
    canChooseReceiver,
  };
}

export async function createPush(
  buyerId: string,
  input: CreatePushInput,
  actor: Actor,
): Promise<{ pushId: string; receiver: { employeeId: string; person: string } }> {
  const status = await getPushStatus(buyerId, actor);
  if (!status.canPush) {
    throw fail(status.blockedReason ?? 'He cannot be pushed now.', undefined, {
      ...(status.alreadySeller ? { existingSellerId: status.alreadySeller.sellerId } : {}),
    });
  }
  let receiver = status.receiver;
  if (input.receiverEmployeeId && input.receiverEmployeeId !== receiver?.employeeId) {
    if (!status.canChooseReceiver) {
      throw fail('Only Admin changes who a push goes to.', 'receiverEmployeeId');
    }
    const chosen = await assertReceiver(input.receiverEmployeeId);
    receiver = { employeeId: id(chosen._id), person: chosen.person };
  }
  if (!receiver) {
    throw fail('His team has no Sales Leader — pick who it goes to.', 'receiverEmployeeId');
  }

  const buyer = (await Buyer.findById(buyerId))!;
  const counterparty = (await Counterparty.findById(buyer.counterpartyId, { firm: 1 }))!;
  const pusher = await personOf(actor.employeeId);
  const to = receiver;
  try {
    const pushId = await withTransaction(async (session) => {
      const [push] = await SellerPush.create(
        [
          {
            counterpartyId: buyer.counterpartyId,
            buyerId: buyer._id,
            pushedByEmployeeId: actor.employeeId,
            pushedAt: new Date(),
            note: input.note,
            receiverEmployeeId: to.employeeId,
          },
        ],
        { session },
      );
      const pushIdStr = id(push!._id);
      await notifyStaff(
        [to.employeeId],
        {
          kind: 'push_received',
          title: `From Sales: ${counterparty.firm ?? 'a buyer'}`,
          body: `${pusher ?? 'Sales'} pushed him to Purchase — "${input.note}"`,
          link: `/purchase/from-sales/${pushIdStr}`,
        },
        session,
      );
      await writeAuditLog(
        {
          actorId: actor.employeeId,
          actorType: 'staff',
          entity: 'seller_push',
          entityId: push!._id as Types.ObjectId,
          field: 'status',
          newValue: { status: 'pending', buyerId, receiverEmployeeId: to.employeeId },
          reason: input.note,
          correlationId: actor.correlationId,
        },
        session,
      );
      return pushIdStr;
    });
    return { pushId, receiver: to };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw fail('A push is already pending.');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sales — "Pushed to Purchase"
// ---------------------------------------------------------------------------

export interface SalesPushRow {
  pushId: string;
  buyerId: string;
  firm: string;
  pushedAt: string;
  pushedBy: string | null;
  purchaseExecutive: string | null;
  status: string;
  rejectionReason: string | null;
}

/** An executive sees his own pushes; a Sales Leader his team's; Admin all. */
export async function listSalesPushes(caller: StaffCaller): Promise<SalesPushRow[]> {
  let pushers: string[] | null = null;
  if (!isAdmin(caller, 'sales') && !caller.permissions.includes(PERMISSIONS.LEADS_SEE_ALL)) {
    pushers = (await isLeaderOf('sales', caller.employeeId))
      ? await teamOf('sales', caller.employeeId)
      : [caller.employeeId];
  }
  const pushes = await SellerPush.find(pushers ? { pushedByEmployeeId: { $in: pushers } } : {})
    .sort({ pushedAt: -1 })
    .limit(200);
  return rowsWith(pushes, (push, firm, names) => ({
    pushId: id(push._id),
    buyerId: id(push.buyerId),
    firm,
    pushedAt: push.pushedAt.toISOString(),
    pushedBy: names.get(id(push.pushedByEmployeeId)) ?? null,
    purchaseExecutive: names.get(id(push.receiverEmployeeId)) ?? null,
    status: push.status,
    rejectionReason: push.rejectionReason ?? null,
  }));
}

type PushDoc = SellerPushDocument & { _id: Types.ObjectId };

async function rowsWith<T>(
  pushes: PushDoc[],
  build: (push: PushDoc, firm: string, names: Map<string, string>) => T,
): Promise<T[]> {
  const [firms, people] = await Promise.all([
    Counterparty.find({ _id: { $in: pushes.map((p) => p.counterpartyId) } }, { firm: 1 }),
    Employee.find(
      { _id: { $in: pushes.flatMap((p) => [p.pushedByEmployeeId, p.receiverEmployeeId]) } },
      { person: 1 },
    ),
  ]);
  const firmOf = new Map(firms.map((c) => [id(c._id), c.firm ?? '']));
  const names = new Map(people.map((e) => [id(e._id), e.person]));
  return pushes.map((p) => build(p, firmOf.get(id(p.counterpartyId)) ?? '', names));
}

// ---------------------------------------------------------------------------
// Purchase — "From Sales"
// ---------------------------------------------------------------------------

export interface PurchasePushRow {
  pushId: string;
  firm: string;
  pushedBy: string | null;
  note: string;
  pushedAt: string;
  receiver: string | null;
  status: string;
}

/** The receiver sees his own; a Purchase Leader his team's; Admin all. */
export async function listPurchasePushes(
  caller: StaffCaller,
  query: ListPushesQuery,
): Promise<PurchasePushRow[]> {
  let receivers: string[] | null = null;
  if (!isAdmin(caller, 'purchase') && !caller.permissions.includes(PERMISSIONS.LEADS_SEE_ALL)) {
    receivers = (await isLeaderOf('purchase', caller.employeeId))
      ? await teamOf('purchase', caller.employeeId)
      : [caller.employeeId];
  }
  const status = query.status ?? 'open';
  const pushes = await SellerPush.find({
    ...(receivers ? { receiverEmployeeId: { $in: receivers } } : {}),
    ...(status === 'open' ? { open: true } : { status }),
  })
    .sort({ pushedAt: -1 })
    .limit(200);
  return rowsWith(pushes, (push, firm, names) => ({
    pushId: id(push._id),
    firm,
    pushedBy: names.get(id(push.pushedByEmployeeId)) ?? null,
    note: push.note,
    pushedAt: push.pushedAt.toISOString(),
    receiver: names.get(id(push.receiverEmployeeId)) ?? null,
    status: push.status,
  }));
}

export interface PushDetailDto {
  pushId: string;
  status: string;
  firm: string;
  ownerName: string | null;
  contactMobile: string | null;
  gstin: string | null;
  pan: string | null;
  licenceNo: string | null;
  location: {
    address: string | null;
    pincode: string | null;
    stateId: string | null;
    districtId: string | null;
    tehsilId: string | null;
    tehsil: string | null;
    district: string | null;
    state: string | null;
  };
  pushedBy: string | null;
  pushedAt: string;
  note: string;
  receiver: { employeeId: string; person: string | null };
  /** What Purchase filled in on the first call, without the bank account. */
  draft: {
    gstin: string | null;
    licenceNo: string | null;
    location: {
      address: string;
      pincode: string | null;
      stateId: string;
      districtId: string;
      tehsilId: string;
    } | null;
    references: Array<{ firm: string; phone: string; relationship: string; whatTheySaid: string }>;
    dealershipIds: string[];
    margPartyCode: string | null;
    callNote: string | null;
    bankDetailGiven: boolean;
  } | null;
  /** The firm has a bank account on file already — Complete need not ask for one. */
  firmHasBankDetail: boolean;
  /** He had only a PAN — approval waits for a GSTIN. */
  needsGstin: boolean;
  canComplete: boolean;
  canDecide: boolean;
  rejectionReason: string | null;
  sellerId: string | null;
}

async function loadPush(pushId: string) {
  const push = /^[a-f0-9]{24}$/i.test(pushId) ? await SellerPush.findById(pushId) : null;
  if (!push) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Push not found.' });
  return push;
}

/** The receiver, his Purchase Leader, or Admin. */
async function assertPurchaseCovers(push: { receiverEmployeeId: unknown }, caller: StaffCaller) {
  if (
    !(await callerCovers('purchase', caller, id(push.receiverEmployeeId), { queueAllowed: false }))
  ) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: 'This push is with another Purchase team.',
    });
  }
}

async function mayDecide(push: { receiverEmployeeId: unknown }, caller: StaffCaller) {
  if (!caller.permissions.includes(PERMISSIONS.SELLER_APPROVE)) return false;
  if (isAdmin(caller, 'purchase')) return true;
  if (!(await isLeaderOf('purchase', caller.employeeId))) return false;
  return callerCovers('purchase', caller, id(push.receiverEmployeeId), { queueAllowed: false });
}

export async function getPush(pushId: string, caller: StaffCaller): Promise<PushDetailDto> {
  const push = await loadPush(pushId);
  await assertPurchaseCovers(push, caller);
  const counterparty = await Counterparty.findById(push.counterpartyId);
  const buyer = await Buyer.findById(push.buyerId, {
    tehsilId: 1,
    address: 1,
    pincode: 1,
    gstPpobAddress: 1,
  });
  const tehsil = buyer?.tehsilId ? await Tehsil.findById(buyer.tehsilId) : null;
  const district = tehsil?.districtId ? await District.findById(tehsil.districtId) : null;
  const open = push.open;
  const draft = push.draft;
  return {
    pushId: id(push._id),
    status: push.status,
    firm: counterparty?.firm ?? '',
    ownerName: counterparty?.ownerName ?? null,
    contactMobile: counterparty?.contactMobile ?? counterparty?.mobile ?? null,
    gstin: counterparty?.gstin ?? null,
    pan: counterparty?.pan ?? null,
    licenceNo: counterparty?.licenceNo ?? null,
    location: {
      address: buyer?.address ?? buyer?.gstPpobAddress ?? null,
      pincode: buyer?.pincode ?? null,
      stateId: district ? id(district.stateId) : null,
      districtId: tehsil?.districtId ? id(tehsil.districtId) : null,
      tehsilId: tehsil ? id(tehsil._id) : null,
      tehsil: tehsil?.name ?? null,
      district: tehsil?.district ?? null,
      state: tehsil?.state ?? null,
    },
    pushedBy: await personOf(push.pushedByEmployeeId),
    pushedAt: push.pushedAt.toISOString(),
    note: push.note,
    receiver: {
      employeeId: id(push.receiverEmployeeId),
      person: await personOf(push.receiverEmployeeId),
    },
    draft: draft
      ? {
          gstin: draft.gstin ?? null,
          licenceNo: draft.licenceNo ?? null,
          location: draft.location?.tehsilId
            ? {
                address: draft.location.address ?? '',
                pincode: draft.location.pincode ?? null,
                stateId: id(draft.location.stateId),
                districtId: id(draft.location.districtId),
                tehsilId: id(draft.location.tehsilId),
              }
            : null,
          references: (draft.references ?? []).map((r) => ({
            firm: r.firm,
            phone: r.phone,
            relationship: r.relationship,
            whatTheySaid: r.whatTheySaid,
          })),
          dealershipIds: (draft.dealershipIds ?? []).map(id),
          margPartyCode: draft.margPartyCode ?? null,
          callNote: draft.callNote ?? null,
          bankDetailGiven: Boolean(draft.bankDetail),
        }
      : null,
    firmHasBankDetail: Boolean(await BankDetail.exists({ counterpartyId: push.counterpartyId })),
    needsGstin: !counterparty?.gstin && !draft?.gstin,
    canComplete:
      open &&
      (await callerCovers('purchase', caller, id(push.receiverEmployeeId), {
        queueAllowed: false,
      })),
    canDecide: push.status === 'submitted' && (await mayDecide(push, caller)),
    rejectionReason: push.rejectionReason ?? null,
    sellerId: push.sellerId ? id(push.sellerId) : null,
  };
}

/** A GSTIN given for a PAN-only firm must be his PAN's, in his state, and nobody else's. */
async function assertGstinFitsFirm(
  gstin: string,
  counterparty: { _id: unknown; pan?: string | null },
  stateId: string,
): Promise<void> {
  if (counterparty.pan && panFromGstin(gstin) !== counterparty.pan) {
    throw fail(
      `This GSTIN carries PAN ${panFromGstin(gstin)}, but the firm's PAN is ${counterparty.pan}.`,
      'gstin',
    );
  }
  await assertGstinState(gstin, stateId, 'gstin');
  const clash = await Counterparty.findOne({ gstin, _id: { $ne: counterparty._id } }, { firm: 1 });
  if (clash) {
    throw fail(`That GSTIN already belongs to ${clash.firm ?? 'another firm'}.`, 'gstin', {
      existingCounterpartyId: id(clash._id),
    });
  }
}

export async function completePush(
  pushId: string,
  input: CompletePushInput,
  actor: Actor,
): Promise<PushDetailDto> {
  const push = await loadPush(pushId);
  await assertPurchaseCovers(push, actor);
  if (!push.open) throw fail('This push has already been decided.');
  const counterparty = (await Counterparty.findById(push.counterpartyId))!;

  if (input.gstin) {
    if (counterparty.gstin && counterparty.gstin !== input.gstin) {
      throw fail(`He already has GSTIN ${counterparty.gstin}.`, 'gstin');
    }
    if (!counterparty.gstin)
      await assertGstinFitsFirm(input.gstin, counterparty, input.location.stateId);
  } else if (counterparty.gstin) {
    await assertGstinState(counterparty.gstin, input.location.stateId, 'location.stateId');
  }
  await assertLocationChain(input.location);
  const dealershipIds = [...new Set((input.dealerships ?? []).map((d) => d.manufacturerId))];
  if (
    dealershipIds.length &&
    (await Manufacturer.countDocuments({ _id: { $in: dealershipIds } })) !== dealershipIds.length
  ) {
    throw fail('One of those companies does not exist.', 'dealerships');
  }
  await assertSellerMargCodeFree(input.margPartyCode);
  const firmHasBank = Boolean(await BankDetail.exists({ counterpartyId: counterparty._id }));
  if (!firmHasBank && !input.bankDetail && !push.draft?.bankDetail) {
    throw fail(
      'Add his bank account — the firm has none on file and a seller is paid.',
      'bankDetail.accountNumber',
    );
  }

  const before = push.status;
  push.draft = {
    gstin: input.gstin ?? null,
    licenceNo: input.licenceNo,
    location: {
      address: input.location.address,
      pincode: input.location.pincode ?? null,
      stateId: input.location.stateId,
      districtId: input.location.districtId,
      tehsilId: input.location.tehsilId,
    },
    references: input.references,
    dealershipIds,
    bankDetail: input.bankDetail
      ? {
          accountEncrypted: encryptAccountNumber(input.bankDetail.accountNumber),
          ifsc: input.bankDetail.ifsc,
          accountName: input.bankDetail.accountName,
        }
      : (push.draft?.bankDetail ?? null),
    margPartyCode: input.margPartyCode ?? null,
    callNote: input.callNote,
  } as never;
  push.status = 'submitted';
  push.submittedAt = new Date();
  push.submittedBy = actor.employeeId as never;
  await withTransaction(async (session) => {
    await push.save({ session });
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'seller_push',
        entityId: push._id as Types.ObjectId,
        field: 'status',
        oldValue: before,
        newValue: 'submitted',
        reason: input.callNote,
        correlationId: actor.correlationId,
      },
      session,
    );
  });
  return getPush(pushId, actor);
}

export async function approvePush(
  pushId: string,
  input: ApprovePushInput,
  actor: Actor,
): Promise<{ sellerId: string }> {
  const push = await loadPush(pushId);
  if (!(await mayDecide(push, actor))) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: "Only the Purchase Leader of the receiver's team, or Admin, decides a push.",
    });
  }
  if (push.status !== 'submitted' || !push.draft) {
    throw fail(
      push.open
        ? 'Purchase has not completed his seller details yet.'
        : 'This push has already been decided.',
    );
  }
  const draft = push.draft;
  const counterparty = (await Counterparty.findById(push.counterpartyId))!;
  const gstin = counterparty.gstin ?? draft.gstin ?? null;
  if (!gstin) {
    throw fail(
      'He has only a PAN — add his GSTIN (Complete) before he can be approved as a seller.',
      'gstin',
    );
  }
  if (!counterparty.gstin)
    await assertGstinFitsFirm(gstin, counterparty, id(draft.location!.stateId));
  if (await Seller.exists({ counterpartyId: counterparty._id }))
    throw fail('He is already a seller.');
  const tehsils = await Tehsil.countDocuments({ _id: { $in: input.tehsilIds } });
  if (tehsils !== input.tehsilIds.length)
    throw fail('One or more tehsils do not exist.', 'tehsilIds');
  await assertMayAssign('purchase', actor, input.assignedToEmployeeId);
  await assertSellerMargCodeFree(draft.margPartyCode ?? undefined);

  const firm = counterparty.firm ?? 'the firm';
  const leaderOfBuyerTeam = await buyerTeamLeader(push.buyerId, id(push.pushedByEmployeeId));

  const sellerId = await withTransaction(async (session) => {
    if (!counterparty.gstin) {
      counterparty.gstin = gstin;
      counterparty.pan = panFromGstin(gstin);
    }
    counterparty.kind = 'both';
    if (draft.licenceNo) counterparty.licenceNo = draft.licenceNo;
    await counterparty.save({ session });

    const [seller] = await Seller.create(
      [
        {
          counterpartyId: counterparty._id,
          tehsilId: draft.location!.tehsilId,
          address: draft.location!.address,
          pincode: draft.location!.pincode ?? null,
          margPartyCode: draft.margPartyCode ?? null,
          dispatchCutoffTime: input.dispatchCutoffTime,
          ...(input.trustTier && input.trustTier !== 'New'
            ? {
                trustTier: input.trustTier,
                tierSeededBy: actor.employeeId,
                tierSeededReason: input.seedReason ?? null,
              }
            : {}),
          pushedFromBuyerId: push.buyerId,
          sourcedByEmployeeId: push.pushedByEmployeeId,
        },
      ],
      { session },
    );
    const sid = seller!._id as Types.ObjectId;
    await SellerReference.create(
      (draft.references ?? []).map((r) => ({
        sellerId: sid,
        firm: r.firm,
        phone: r.phone,
        relationship: r.relationship,
        whatTheySaid: r.whatTheySaid,
      })),
      { session, ordered: true },
    );
    if (draft.dealershipIds?.length) {
      await SellerDealership.create(
        draft.dealershipIds.map((manufacturerId) => ({
          sellerId: sid,
          manufacturerId,
          setBy: push.submittedBy ?? actor.employeeId,
        })),
        { session, ordered: true },
      );
    }
    if (draft.bankDetail) {
      await BankDetail.create(
        [
          {
            counterpartyId: counterparty._id,
            accountEncrypted: draft.bankDetail.accountEncrypted,
            ifsc: draft.bankDetail.ifsc,
            accountName: draft.bankDetail.accountName,
            isActive: false,
          },
        ],
        { session },
      );
    }
    await SellerArea.create(
      input.tehsilIds.map((tehsilId) => ({
        sellerId: sid,
        tehsilId,
        setBy: actor.employeeId,
        setAt: new Date(),
      })),
      { session, ordered: true },
    );
    await SellerAssignment.create(
      [
        {
          sellerId: sid,
          ownerEmployeeId: input.assignedToEmployeeId,
          assignedAt: new Date(),
          assignedBy: actor.employeeId,
          reason: 'Assigned at approval (Push to Purchase).',
        },
      ],
      { session },
    );
    if (draft.location?.pincode) {
      await recordPincodeIfUnknown(
        { pincode: draft.location.pincode, tehsilId: id(draft.location.tehsilId) },
        actor,
        session,
      );
    }

    push.status = 'approved';
    push.open = false;
    push.decidedAt = new Date();
    push.decidedBy = actor.employeeId as never;
    push.sellerId = sid as never;
    await push.save({ session });

    await notifyStaff(
      [push.pushedByEmployeeId, leaderOfBuyerTeam],
      {
        kind: 'push_approved',
        title: `${firm} is now a seller`,
        body: `Purchase approved the buyer you pushed. He stays your buyer; his seller side is Purchase's.`,
        link: '/sales/pushed',
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'seller_push',
        entityId: push._id as Types.ObjectId,
        field: 'status',
        oldValue: 'submitted',
        newValue: { status: 'approved', sellerId: id(sid), gstin },
        correlationId: actor.correlationId,
      },
      session,
    );
    return id(sid);
  });
  return { sellerId };
}

export async function rejectPush(pushId: string, reason: string, actor: Actor): Promise<void> {
  const push = await loadPush(pushId);
  if (!(await mayDecide(push, actor))) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: "Only the Purchase Leader of the receiver's team, or Admin, decides a push.",
    });
  }
  if (!push.open) throw fail('This push has already been decided.');
  const counterparty = await Counterparty.findById(push.counterpartyId, { firm: 1 });
  const pusherLeader = await leaderOf('sales', id(push.pushedByEmployeeId));
  const before = push.status;
  await withTransaction(async (session) => {
    push.status = 'rejected';
    push.open = false;
    push.rejectionReason = reason;
    push.decidedAt = new Date();
    push.decidedBy = actor.employeeId as never;
    await push.save({ session });
    await notifyStaff(
      [push.pushedByEmployeeId, pusherLeader],
      {
        kind: 'push_rejected',
        title: `Purchase did not take ${counterparty?.firm ?? 'the buyer you pushed'}`,
        body: `Reason: ${reason}`,
        link: '/sales/pushed',
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'seller_push',
        entityId: push._id as Types.ObjectId,
        field: 'status',
        oldValue: before,
        newValue: 'rejected',
        reason,
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}
