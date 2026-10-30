import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Seller } from '../../models/Seller.js';
import { Buyer } from '../../models/Buyer.js';
import { SellerAssignment } from '../../models/SellerAssignment.js';
import { Employee } from '../../models/Employee.js';
import { Tehsil } from '../../models/Tehsil.js';
import { District } from '../../models/District.js';
import { State } from '../../models/State.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { gstinMatchesStateCode, panFromGstin } from '../../shared/validators.js';
import {
  assertMayAssign,
  callerCovers,
  defaultAssignee,
  leaderOf,
  mayChangeOwner,
  type StaffCaller,
} from '../../shared/team.js';
import { assertLocationChain, recordPincodeIfUnknown } from '../territory/territory.masters.js';
import { registerSeller } from './onboarding.service.js';
import type { Location } from './buyer.registration.js';

/**
 * Phase 4 — the staff side of a seller: "Add a seller" on a call (location,
 * Assigned to, Marg party code, no OTP), and the seller profile with Edit —
 * the same rules as buyers, on the Purchase side. GSTIN stays mandatory
 * for a seller (TriFid buys on a GST invoice).
 */
type Caller = StaffCaller & { correlationId: string };
const id = (value: unknown): string => String(value);

export async function assertGstinState(
  gstin: string,
  stateId: string,
  field: string,
): Promise<void> {
  const state = await State.findById(stateId);
  if (state && !gstinMatchesStateCode(gstin, state.gstStateCode)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `This GSTIN starts with state code ${gstin.slice(0, 2)}, but the address is in ${state.name} (${state.gstStateCode}).`,
      field,
    });
  }
}

export async function assertSellerMargCodeFree(code: string | undefined, exceptSellerId?: string) {
  if (!code) return;
  const clash = await Seller.findOne({
    margPartyCode: code,
    ...(exceptSellerId ? { _id: { $ne: exceptSellerId } } : {}),
  });
  if (clash) {
    const cp = await Counterparty.findById(clash.counterpartyId, { firm: 1 });
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `Marg party code ${code} already belongs to ${cp?.firm ?? 'another seller'}.`,
      field: 'margPartyCode',
      meta: { existingCounterpartyId: id(clash.counterpartyId), existingFirm: cp?.firm ?? '' },
    });
  }
}

/**
 * Phase 6 (BR-366) — a firm that is already a buyer becomes a seller only
 * through Push to Purchase, which adds the seller side to his own record.
 * Saying so beats the generic "an account already exists".
 */
async function assertNotAlreadyABuyer(gstin: string): Promise<void> {
  const existing = await Counterparty.findOne({ gstin, deletedAt: null }, { firm: 1 });
  if (!existing) return;
  const [buyer, seller] = await Promise.all([
    Buyer.findOne({ counterpartyId: existing._id }, { _id: 1 }),
    Seller.exists({ counterpartyId: existing._id }),
  ]);
  if (buyer && !seller) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${existing.firm ?? 'This firm'} is already a buyer. Ask Sales to use Push to Purchase on his buyer file — one firm, one record.`,
      field: 'gstin',
      meta: { existingCounterpartyId: id(existing._id), existingBuyerId: id(buyer._id) },
    });
  }
}

export interface StaffSellerInput {
  mobile: string;
  firm: string;
  gstin: string;
  ownerName: string;
  licenceNo?: string; // DEC-069 — optional on the staff form.
  references?: Array<{ firm: string; phone: string; relationship: string; whatTheySaid: string }>;
  dealerships?: Array<{ manufacturerId: string }>;
  bankDetail?: { accountNumber: string; ifsc: string; accountName: string };
  consent: { noticeVersion: string; marketingOptIn: boolean };
  callNote: string;
  location: Location;
  margPartyCode?: string;
  assignedToEmployeeId?: string | null;
  proprietorAgreed: true;
}

export async function registerSellerByStaff(
  input: StaffSellerInput,
  caller: Caller,
): Promise<{ registrationId: string; accountNameWarning: string | null }> {
  await assertNotAlreadyABuyer(input.gstin);
  await assertGstinState(input.gstin, input.location.stateId, 'gstin');
  const place = await assertLocationChain(input.location);
  await assertSellerMargCodeFree(input.margPartyCode);
  // Left out → the person adding him (a Purchase executive — every Sales
  // Leader is one); null → the Queue; otherwise the assign rule decides.
  const assignee =
    input.assignedToEmployeeId === undefined
      ? await defaultAssignee('purchase', caller.employeeId)
      : input.assignedToEmployeeId;
  await assertMayAssign('purchase', caller, assignee);

  const {
    callNote,
    location,
    margPartyCode,
    assignedToEmployeeId: _assigned,
    proprietorAgreed: _agreed,
    ...base
  } = input;
  void _assigned;
  void _agreed;
  return registerSeller(
    base,
    { employeeId: caller.employeeId, callNote, correlationId: caller.correlationId },
    caller.correlationId,
    { location, tehsilId: place.tehsilId, margPartyCode, assignee, caller },
  );
}

// ---------------------------------------------------------------------------
// Profile and Edit
// ---------------------------------------------------------------------------

export interface SellerProfileDto {
  sellerId: string;
  counterpartyId: string;
  status: string;
  firm: string;
  ownerName: string | null;
  gstin: string | null;
  pan: string | null;
  loginMobile: string | null;
  contactMobile: string | null;
  licenceNo: string | null;
  margPartyCode: string | null;
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
  assignedTo: { employeeId: string; person: string } | null;
  assignedLeader: { employeeId: string; person: string } | null;
  canEdit: boolean;
  canEditIdentity: boolean;
  /** Phase 5 — his leader (for his team and the Queue) or Admin. */
  canChangeOwner: boolean;
}

export async function getSellerProfile(
  ref: { sellerId?: string; counterpartyId?: string },
  caller: StaffCaller,
): Promise<SellerProfileDto> {
  const seller = ref.sellerId
    ? await Seller.findById(ref.sellerId)
    : await Seller.findOne({ counterpartyId: ref.counterpartyId });
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const counterparty = await Counterparty.findById(seller.counterpartyId);
  if (!counterparty) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const tehsil = seller.tehsilId ? await Tehsil.findById(seller.tehsilId) : null;
  const district = tehsil?.districtId ? await District.findById(tehsil.districtId) : null;
  const assignment = await SellerAssignment.findOne({ sellerId: seller._id });
  const owner = assignment
    ? await Employee.findById(assignment.ownerEmployeeId, { person: 1 })
    : null;
  const leaderId = owner ? await leaderOf('purchase', id(owner._id)) : null;
  const leader = leaderId ? await Employee.findById(leaderId, { person: 1 }) : null;
  return {
    sellerId: id(seller._id),
    counterpartyId: id(counterparty._id),
    status: counterparty.status,
    firm: counterparty.firm ?? '',
    ownerName: counterparty.ownerName ?? null,
    gstin: counterparty.gstin ?? null,
    pan: counterparty.pan ?? null,
    loginMobile: counterparty.mobile ?? null,
    contactMobile: counterparty.contactMobile ?? counterparty.mobile ?? null,
    licenceNo: counterparty.licenceNo ?? null,
    margPartyCode: seller.margPartyCode ?? null,
    location: {
      address: seller.address ?? null,
      pincode: seller.pincode ?? null,
      stateId: district ? id(district.stateId) : null,
      districtId: tehsil?.districtId ? id(tehsil.districtId) : null,
      tehsilId: tehsil ? id(tehsil._id) : null,
      tehsil: tehsil?.name ?? null,
      district: tehsil?.district ?? null,
      state: tehsil?.state ?? null,
    },
    assignedTo: owner ? { employeeId: id(owner._id), person: owner.person } : null,
    assignedLeader: leader ? { employeeId: id(leader._id), person: leader.person } : null,
    canEdit: await callerCovers('purchase', caller, owner ? id(owner._id) : null, {
      queueAllowed: false,
    }),
    canEditIdentity: caller.permissions.includes(PERMISSIONS.SELLER_ADMIN),
    canChangeOwner: await mayChangeOwner('purchase', caller, owner ? id(owner._id) : null),
  };
}

export interface UpdateSellerInput {
  firm: string;
  ownerName: string;
  contactMobile: string;
  gstin: string;
  licenceNo?: string; // DEC-069 — a seller added without one can still be edited.
  location: Location;
  margPartyCode?: string;
}

/**
 * Phase 4 — Edit on the seller profile: his assigned purchase executive,
 * that executive's leader, or Admin; only Admin changes the GSTIN.
 */
export async function updateSellerProfile(
  sellerId: string,
  input: UpdateSellerInput,
  caller: Caller,
): Promise<SellerProfileDto> {
  const before = await getSellerProfile({ sellerId }, caller);
  if (!before.canEdit) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn:
        'Only his assigned executive, that executive’s leader, or Admin can edit this seller.',
    });
  }
  const gstin = input.gstin.trim().toUpperCase();
  if (gstin !== before.gstin) {
    if (!before.canEditIdentity) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        messageEn: 'Only Admin can change a seller’s GSTIN.',
        field: 'gstin',
      });
    }
    const clash = await Counterparty.findOne({ gstin, _id: { $ne: before.counterpartyId } });
    if (clash) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `This GSTIN is already registered — ${clash.firm ?? 'another firm'}.`,
        field: 'gstin',
        meta: { existingCounterpartyId: id(clash._id), existingFirm: clash.firm ?? '' },
      });
    }
  }
  await assertGstinState(gstin, input.location.stateId, 'gstin');
  const place = await assertLocationChain(input.location);
  await assertSellerMargCodeFree(input.margPartyCode, sellerId);

  await withTransaction(async (session) => {
    await Counterparty.updateOne(
      { _id: before.counterpartyId },
      {
        $set: {
          firm: input.firm,
          ownerName: input.ownerName,
          contactMobile: input.contactMobile,
          gstin,
          pan: panFromGstin(gstin),
          licenceNo: input.licenceNo ?? null,
        },
      },
      { session },
    );
    await Seller.updateOne(
      { _id: sellerId },
      {
        $set: {
          tehsilId: place.tehsilId as Types.ObjectId,
          address: input.location.address,
          pincode: input.location.pincode ?? null,
          margPartyCode: input.margPartyCode ?? null,
        },
      },
      { session },
    );
    if (input.location.pincode) {
      await recordPincodeIfUnknown(
        { pincode: input.location.pincode, tehsilId: input.location.tehsilId },
        caller,
        session,
      );
    }
    await writeAuditLog(
      {
        actorId: caller.employeeId,
        actorType: 'staff',
        entity: 'seller',
        entityId: sellerId,
        field: 'edit',
        oldValue: {
          firm: before.firm,
          gstin: before.gstin,
          contactMobile: before.contactMobile,
          tehsilId: before.location.tehsilId,
          margPartyCode: before.margPartyCode,
        },
        newValue: {
          firm: input.firm,
          gstin,
          contactMobile: input.contactMobile,
          tehsilId: input.location.tehsilId,
          margPartyCode: input.margPartyCode ?? null,
        },
        correlationId: caller.correlationId,
      },
      session,
    );
  });
  return getSellerProfile({ sellerId }, caller);
}
