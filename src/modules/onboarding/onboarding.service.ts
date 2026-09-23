import type { ClientSession, Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { BuyerDealership } from '../../models/BuyerDealership.js';
import { Seller } from '../../models/Seller.js';
import { SellerReference } from '../../models/SellerReference.js';
import { SellerArea } from '../../models/SellerArea.js';
import { BankDetail } from '../../models/BankDetail.js';
import { Consent } from '../../models/Consent.js';
import { Tehsil } from '../../models/Tehsil.js';
import { AuditLog } from '../../models/AuditLog.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { isValidGstin, isValidIfsc } from '../../shared/validators.js';
import { encryptAccountNumber } from '../../shared/encryption.js';
import { enqueueNotification } from '../notification/notification.outbox.js';
import { toBankDetailDto, type BankDetailDto } from './onboarding.dto.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

/**
 * Staff-assisted enquiries — present only when a desk raised this
 * registration on a phone call. `registerBuyer`/`registerSeller` below stay
 * the one function that creates a registration either way, so a
 * staff-assisted registration gets exactly the same validation a self-service
 * one does; this parameter only ever adds the annotation, never a rule.
 */
export interface StaffAssistedRegistration {
  employeeId: string;
  callNote: string;
  correlationId: string;
}

interface BankDetailInput {
  accountNumber: string;
  ifsc: string;
  accountName: string;
}

interface ConsentInput {
  noticeVersion: string;
  marketingOptIn: boolean;
}

async function assertGstinAndMobileAreFree(gstin: string, mobile: string): Promise<void> {
  if (!isValidGstin(gstin)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That GSTIN does not check out.',
      field: 'gstin',
    });
  }
  const existing = await Counterparty.findOne({ $or: [{ gstin }, { mobile }], deletedAt: null });
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'An account already exists for this GSTIN or mobile number.',
      field: existing.gstin === gstin ? 'gstin' : 'mobile',
      retryable: false,
    });
  }
}

// Staff-assisted enquiries — a registration raised on a phone call cannot be
// approved until a single OTP to the real phone number has confirmed it is
// genuine, even with every other field filled in correctly. Self-service
// registrations (staffAssisted: false) are untouched by this gate.
function assertStaffAssistedOtpConfirmed(counterparty: {
  staffAssisted?: boolean;
  staffAssistedOtpVerifiedAt?: Date | null;
}): void {
  if (counterparty.staffAssisted && !counterparty.staffAssistedOtpVerifiedAt) {
    throw new AppError({
      code: 'OTP_CONFIRMATION_REQUIRED',
      messageEn:
        'This registration was staff-assisted and still needs an OTP confirmation to the real phone number before it can be approved.',
      field: 'staffAssistedOtpVerifiedAt',
    });
  }
}

function assertBankDetailIsWellFormed(bankDetail: BankDetailInput): void {
  if (!isValidIfsc(bankDetail.ifsc)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That IFSC code is not valid.',
      field: 'ifsc',
    });
  }
}

// BR-340 — three consent records, versioned and timestamped. Marketing is a
// separate opt-in: if declined, no record is written at all (absence is the
// correct "not consented" state under DPDP, not a record saying so).
async function writeConsents(
  counterpartyId: Types.ObjectId,
  consent: ConsentInput,
  session: ClientSession,
): Promise<void> {
  const now = new Date();
  await Consent.create(
    [
      { counterpartyId, type: 'terms', noticeVersion: consent.noticeVersion, givenAt: now },
      { counterpartyId, type: 'transactional', noticeVersion: consent.noticeVersion, givenAt: now },
      ...(consent.marketingOptIn
        ? [
            {
              counterpartyId,
              type: 'marketing' as const,
              noticeVersion: consent.noticeVersion,
              givenAt: now,
            },
          ]
        : []),
    ],
    { session, ordered: true },
  );
}

async function createPendingBankDetail(
  counterpartyId: Types.ObjectId,
  input: BankDetailInput,
  session: ClientSession,
): Promise<void> {
  await BankDetail.create(
    [
      {
        counterpartyId,
        accountEncrypted: encryptAccountNumber(input.accountNumber),
        ifsc: input.ifsc,
        accountName: input.accountName,
        isActive: false,
      },
    ],
    { session },
  );
}

interface RegisterBuyerInput {
  mobile: string;
  firm: string;
  gstin: string;
  ownerName: string;
  licenceNo: string;
  gstPpobAddress: string;
  dealerships?: Array<{ manufacturerId: string; isStrong?: boolean }>;
  bankDetail: BankDetailInput;
  consent: ConsentInput;
}

/** API-010. WF-01 steps 1–5. */
export async function registerBuyer(
  input: RegisterBuyerInput,
  staffAssisted?: StaffAssistedRegistration,
): Promise<{ registrationId: string }> {
  await assertGstinAndMobileAreFree(input.gstin, input.mobile);
  assertBankDetailIsWellFormed(input.bankDetail);

  const registrationId = await withTransaction(async (session) => {
    const [counterparty] = await Counterparty.create(
      [
        {
          mobile: input.mobile,
          firm: input.firm,
          gstin: input.gstin,
          ownerName: input.ownerName,
          licenceNo: input.licenceNo,
          kind: 'buyer',
          status: 'pending',
          ...(staffAssisted
            ? {
                staffAssisted: true,
                staffAssistedByEmployeeId: staffAssisted.employeeId,
                staffAssistedCallNote: staffAssisted.callNote,
              }
            : {}),
        },
      ],
      { session },
    );
    if (!counterparty) throw new Error('Counterparty.create returned no document.');

    const [buyer] = await Buyer.create(
      [{ counterpartyId: counterparty._id, gstPpobAddress: input.gstPpobAddress }],
      { session },
    );
    if (!buyer) throw new Error('Buyer.create returned no document.');

    if (input.dealerships && input.dealerships.length > 0) {
      await BuyerDealership.create(
        input.dealerships.map((dealership) => ({
          buyerId: buyer._id,
          manufacturerId: dealership.manufacturerId,
          isStrong: dealership.isStrong ?? false,
        })),
        { session, ordered: true },
      );
    }

    await createPendingBankDetail(counterparty._id, input.bankDetail, session);
    await writeConsents(counterparty._id, input.consent, session);

    if (staffAssisted) {
      await writeAuditLog(
        {
          actorId: (counterparty._id as Types.ObjectId).toString(),
          actorType: 'counterparty',
          entity: 'counterparty',
          entityId: counterparty._id as Types.ObjectId,
          field: 'staff_assisted_registration',
          reason: `Logged by staff ${staffAssisted.employeeId}: ${staffAssisted.callNote}`,
          correlationId: staffAssisted.correlationId,
        },
        session,
      );
    }

    return (counterparty._id as Types.ObjectId).toString();
  });

  return { registrationId };
}

interface RegisterSellerInput {
  mobile: string;
  firm: string;
  gstin: string;
  ownerName: string;
  licenceNo: string;
  references: Array<{ firm: string; phone: string; relationship: string; whatTheySaid: string }>;
  bankDetail: BankDetailInput;
  consent: ConsentInput;
}

/** API-011. WF-02. */
export async function registerSeller(
  input: RegisterSellerInput,
  staffAssisted?: StaffAssistedRegistration,
): Promise<{ registrationId: string }> {
  await assertGstinAndMobileAreFree(input.gstin, input.mobile);
  assertBankDetailIsWellFormed(input.bankDetail);

  const registrationId = await withTransaction(async (session) => {
    const [counterparty] = await Counterparty.create(
      [
        {
          mobile: input.mobile,
          firm: input.firm,
          gstin: input.gstin,
          ownerName: input.ownerName,
          licenceNo: input.licenceNo,
          kind: 'seller',
          status: 'pending',
          ...(staffAssisted
            ? {
                staffAssisted: true,
                staffAssistedByEmployeeId: staffAssisted.employeeId,
                staffAssistedCallNote: staffAssisted.callNote,
              }
            : {}),
        },
      ],
      { session },
    );
    if (!counterparty) throw new Error('Counterparty.create returned no document.');

    const [seller] = await Seller.create([{ counterpartyId: counterparty._id }], { session });
    if (!seller) throw new Error('Seller.create returned no document.');

    await SellerReference.create(
      input.references.map((reference) => ({ sellerId: seller._id, ...reference })),
      { session, ordered: true },
    );

    await createPendingBankDetail(counterparty._id, input.bankDetail, session);
    await writeConsents(counterparty._id, input.consent, session);

    if (staffAssisted) {
      await writeAuditLog(
        {
          actorId: (counterparty._id as Types.ObjectId).toString(),
          actorType: 'counterparty',
          entity: 'counterparty',
          entityId: counterparty._id as Types.ObjectId,
          field: 'staff_assisted_registration',
          reason: `Logged by staff ${staffAssisted.employeeId}: ${staffAssisted.callNote}`,
          correlationId: staffAssisted.correlationId,
        },
        session,
      );
    }

    return (counterparty._id as Types.ObjectId).toString();
  });

  return { registrationId };
}

interface RegistrationStatusDto {
  registrationId: string;
  kind: string;
  status: string;
  rejectionReason?: string;
  staffAssisted: boolean;
  staffAssistedOtpVerifiedAt: Date | null;
}

/** API-012. */
export async function getRegistration(
  registrationId: string,
  requesterCounterpartyId: string | undefined,
): Promise<RegistrationStatusDto> {
  const counterparty = await Counterparty.findById(registrationId);
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
  }
  // A counterparty may only read their own registration; staff (no
  // requesterCounterpartyId) may read any.
  if (requesterCounterpartyId && requesterCounterpartyId !== registrationId) {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }

  const result: RegistrationStatusDto = {
    registrationId: (counterparty._id as Types.ObjectId).toString(),
    kind: counterparty.kind,
    status: counterparty.status,
    staffAssisted: counterparty.staffAssisted ?? false,
    staffAssistedOtpVerifiedAt: counterparty.staffAssistedOtpVerifiedAt ?? null,
  };

  if (counterparty.status === 'rejected') {
    const rejectionEntry = await AuditLog.findOne({
      entity: 'counterparty',
      entityId: counterparty._id,
      field: 'status',
      newValue: 'rejected',
    }).sort({ createdAt: -1 });
    result.rejectionReason = rejectionEntry?.reason ?? undefined;
  }

  return result;
}

interface RegistrationListItem {
  registrationId: string;
  firm?: string;
  gstin?: string;
  kind: string;
  status: string;
  createdAt: Date;
  staffAssisted: boolean;
}

/** API-013. */
export async function listRegistrations(
  stage: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: RegistrationListItem[]; nextCursor?: string }> {
  const query: Record<string, unknown> = {};
  if (stage) query.status = stage;
  if (cursor) query._id = { $gt: cursor };

  const registrations = await Counterparty.find(query)
    .sort({ _id: 1 })
    .limit(limit + 1);

  const hasMore = registrations.length > limit;
  const page = hasMore ? registrations.slice(0, limit) : registrations;

  const items = page.map((counterparty) => ({
    registrationId: (counterparty._id as Types.ObjectId).toString(),
    firm: counterparty.firm ?? undefined,
    gstin: counterparty.gstin ?? undefined,
    kind: counterparty.kind,
    status: counterparty.status,
    createdAt: counterparty.createdAt as Date,
    staffAssisted: counterparty.staffAssisted ?? false,
  }));

  const nextCursor = hasMore
    ? (page[page.length - 1]!._id as Types.ObjectId).toString()
    : undefined;
  return { items, nextCursor };
}

interface ApproveBuyerInput {
  tehsilId: string;
  tradePosition: 'distributor' | 'dealer' | 'retailer';
  isTrader: boolean;
}

/** API-014, buyer branch. BR-081 — rejects without a tehsil, enforced by the required field on the schema. */
export async function approveBuyer(
  registrationId: string,
  input: ApproveBuyerInput,
  actor: StaffActor,
): Promise<void> {
  const tehsil = await Tehsil.findById(input.tehsilId);
  if (!tehsil) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'That tehsil does not exist.',
      field: 'tehsilId',
    });
  }

  const counterparty = await Counterparty.findOne({
    _id: registrationId,
    kind: { $in: ['buyer', 'both'] },
  });
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer registration not found.' });
  }
  if (counterparty.status !== 'pending') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This registration has already been decided.',
    });
  }
  assertStaffAssistedOtpConfirmed(counterparty);

  await withTransaction(async (session) => {
    await Buyer.updateOne(
      { counterpartyId: counterparty._id },
      {
        $set: {
          tehsilId: input.tehsilId,
          tradePosition: input.tradePosition,
          isTrader: input.isTrader,
          classified: true,
        },
      },
      { session },
    );
    counterparty.status = 'active';
    await counterparty.save({ session });

    await enqueueNotification(
      {
        counterpartyId: counterparty._id as Types.ObjectId,
        templateKey: 'registration_invite',
        params: { outcome: 'approved' },
        correlationId: actor.correlationId,
      },
      session,
    );

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'counterparty',
        entityId: counterparty._id as Types.ObjectId,
        field: 'status',
        oldValue: 'pending',
        newValue: 'active',
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}

interface ApproveSellerInput {
  tehsilIds: string[];
  dispatchCutoffTime: string;
  trustTier?: 'New' | 'Verified' | 'Trusted' | 'Committed';
  seedReason?: string;
}

const TRUST_TIER_ORDER = ['New', 'Verified', 'Trusted', 'Committed'];

/** API-014, seller branch. BR-083 — rejects without an area. */
export async function approveSeller(
  registrationId: string,
  input: ApproveSellerInput,
  actor: StaffActor,
): Promise<void> {
  const tehsils = await Tehsil.find({ _id: { $in: input.tehsilIds } });
  if (tehsils.length !== input.tehsilIds.length) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'One or more tehsils do not exist.',
      field: 'tehsilIds',
    });
  }

  const counterparty = await Counterparty.findOne({
    _id: registrationId,
    kind: { $in: ['seller', 'both'] },
  });
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller registration not found.' });
  }
  if (counterparty.status !== 'pending') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This registration has already been decided.',
    });
  }

  assertStaffAssistedOtpConfirmed(counterparty);

  const seller = await Seller.findOne({ counterpartyId: counterparty._id });
  if (!seller) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller profile not found.' });
  }

  // BR-246 — monotonic: a seed can only ever move the tier forward, never back.
  if (input.trustTier) {
    const currentIndex = TRUST_TIER_ORDER.indexOf(seller.trustTier);
    const requestedIndex = TRUST_TIER_ORDER.indexOf(input.trustTier);
    if (requestedIndex < currentIndex) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'A trust tier can only move forward, never back.',
        field: 'trustTier',
      });
    }
  }

  await withTransaction(async (session) => {
    await SellerArea.create(
      input.tehsilIds.map((tehsilId) => ({
        sellerId: seller._id,
        tehsilId,
        setBy: actor.employeeId,
        setAt: new Date(),
      })),
      { session, ordered: true },
    );

    seller.dispatchCutoffTime = input.dispatchCutoffTime;
    if (input.trustTier && input.trustTier !== seller.trustTier) {
      seller.trustTier = input.trustTier;
      seller.tierSeededBy = actor.employeeId as unknown as Types.ObjectId;
      seller.tierSeededReason = input.seedReason ?? null;
    }
    await seller.save({ session });

    counterparty.status = 'active';
    await counterparty.save({ session });

    await enqueueNotification(
      {
        counterpartyId: counterparty._id as Types.ObjectId,
        templateKey: 'registration_invite',
        params: { outcome: 'approved' },
        correlationId: actor.correlationId,
      },
      session,
    );

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'counterparty',
        entityId: counterparty._id as Types.ObjectId,
        field: 'status',
        oldValue: 'pending',
        newValue: 'active',
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}

/** API-015. */
export async function rejectRegistration(
  registrationId: string,
  reason: string,
  actor: StaffActor,
): Promise<void> {
  const counterparty = await Counterparty.findById(registrationId);
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
  }
  if (counterparty.status !== 'pending') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This registration has already been decided.',
    });
  }

  // TD-004 — the rejection, its audit line and the notification API-015 promises
  // ("Fires a notification") commit together.
  await withTransaction(async (session) => {
    counterparty.status = 'rejected';
    await counterparty.save({ session });

    await enqueueNotification(
      {
        counterpartyId: counterparty._id as Types.ObjectId,
        templateKey: 'registration_invite',
        params: { outcome: 'rejected' }, // A coded outcome only — the free-text reason stays internal.
        correlationId: actor.correlationId,
      },
      session,
    );

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'counterparty',
        entityId: counterparty._id as Types.ObjectId,
        field: 'status',
        oldValue: 'pending',
        newValue: 'rejected',
        reason,
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}

/** Staff-facing: masked bank detail for a counterparty (new — see API_CONTRACT.md). */
export async function getBankDetail(counterpartyId: string): Promise<BankDetailDto[]> {
  const details = await BankDetail.find({ counterpartyId }).sort({ createdAt: -1 });
  return details.map(toBankDetailDto);
}

/**
 * BR-017 — a change does not become payable-to until 24 hours after a
 * verified call-back to the number already on file. This creates the
 * pending replacement; `logBankDetailCallback` below starts the clock.
 */
export async function changeBankDetail(
  counterpartyId: string,
  input: BankDetailInput,
  actor: StaffActor,
): Promise<BankDetailDto> {
  assertBankDetailIsWellFormed(input);
  const counterparty = await Counterparty.findById(counterpartyId);
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Counterparty not found.' });
  }

  const pending = await BankDetail.create({
    counterpartyId,
    accountEncrypted: encryptAccountNumber(input.accountNumber),
    ifsc: input.ifsc,
    accountName: input.accountName,
    isActive: false,
  });

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'bank_detail',
    entityId: pending._id as Types.ObjectId,
    field: 'create_pending_change',
    correlationId: actor.correlationId,
  });

  return toBankDetailDto(pending);
}

/**
 * Logs the call-back to the number already on file and starts the
 * 24-hour cooling clock (BR-017). It does not flip `isActive` itself —
 * `isBankDetailPayable` below is the read-time check M4's payout gate will
 * call once money exists.
 */
export async function logBankDetailCallback(
  bankDetailId: string,
  actor: StaffActor,
): Promise<BankDetailDto> {
  const pending = await BankDetail.findById(bankDetailId);
  if (!pending) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Bank detail not found.' });
  }
  if (pending.callbackLoggedAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A call-back was already logged for this change.',
    });
  }

  const now = new Date();
  pending.callbackLoggedAt = now;
  pending.verifiedAt = now;
  pending.verifiedBy = actor.employeeId as unknown as Types.ObjectId;
  pending.effectiveFrom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await pending.save();

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'bank_detail',
    entityId: pending._id as Types.ObjectId,
    field: 'callback_logged',
    newValue: { effectiveFrom: pending.effectiveFrom },
    correlationId: actor.correlationId,
  });

  return toBankDetailDto(pending);
}

// Read-time payability check — BR-017. Nothing consumes this yet (payout is
// M4), but it is the single place that answers "is this bank detail
// payable-to right now", so a later payout gate never has to re-derive it.
export function isBankDetailPayable(detail: {
  verifiedAt: Date | null;
  effectiveFrom: Date | null;
}): boolean {
  if (!detail.verifiedAt || !detail.effectiveFrom) return false;
  return detail.effectiveFrom.getTime() <= Date.now();
}
