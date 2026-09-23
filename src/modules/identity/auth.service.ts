import { randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { verify as verifyTotp } from 'otplib';
import { env, isProduction } from '../../config/env.js';
import { MFA_REQUIRED_ROLE_KEYS } from '../../config/permissions.js';
import { AuthOtp, type AuthOtpDocument } from '../../models/AuthOtp.js';
import { AuthSession } from '../../models/AuthSession.js';
import { Counterparty, type CounterpartyDocument } from '../../models/Counterparty.js';
import { Employee, type EmployeeDocument } from '../../models/Employee.js';
import { Role } from '../../models/Role.js';
import { bumpCounter, isLockedOut, setLockout } from '../../middleware/rateLimit.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { addSeconds } from '../../shared/clock.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signMfaPendingToken,
  signReauthToken,
  verifyMfaPendingToken,
  MFA_PENDING_TOKEN_TTL_SECONDS_EXPORTED,
  REAUTH_TOKEN_TTL_SECONDS_EXPORTED,
  type AccessTokenClaims,
} from '../../shared/tokens.js';
import type {
  BothMeDto,
  BuyerMeDto,
  MeResponse,
  SellerMeDto,
  StaffMeDto,
} from '../../shared/dto/identity.dto.js';
import type { HydratedDocument, Types } from 'mongoose';

const OTP_LENGTH = 6;

function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');
}

// OTP_DEV_FIXED_CODE (developer addition, config/env.ts) — never honoured in
// production, whatever the variable is set to, so a fixed code can never
// ship live by an env-file mistake.
function pickOtpCode(): string {
  if (!isProduction && env.otpDevFixedCode) return env.otpDevFixedCode;
  return generateOtpCode();
}

// MFA_DEV_BYPASS_CODE (developer addition, config/env.ts) — same idea as
// pickOtpCode() above, for staff TOTP MFA. Checked before the real TOTP
// verification so a developer never needs an authenticator app locally;
// never honoured in production, whatever the variable is set to.
async function checkMfaCode(secret: string, code: string): Promise<boolean> {
  if (!isProduction && env.mfaDevBypassCode && code === env.mfaDevBypassCode) {
    return true;
  }
  const totpResult = await verifyTotp({ secret, token: code, epochTolerance: 30 });
  return totpResult.valid;
}

function maskMobile(mobile: string): string {
  return `${mobile.slice(0, 2)}${'*'.repeat(mobile.length - 4)}${mobile.slice(-2)}`;
}

interface RequestOtpResult {
  requestId?: string;
  expiresIn: number;
  maskedMobile: string;
  accountExists: boolean;
  devCode?: string;
}

/**
 * API-001. Only ever sends a code for a mobile that already maps to a
 * counterparty — an unknown mobile gets `accountExists: false` and no OTP is
 * created, so the frontend routes it to the registration placeholder instead
 * of the OTP screen (M3 builds the real registration content).
 */
export async function requestOtp(mobile: string, ip: string): Promise<RequestOtpResult> {
  const lockoutKey = `otp-lockout:${mobile}`;
  if (await isLockedOut(lockoutKey)) {
    throw new AppError({
      code: 'LOCKED_OUT',
      messageEn: 'Too many attempts. Try again after 30 minutes, or call the sales desk.',
      messageHi: 'बहुत बार कोशिश हुई। 30 मिनट बाद कोशिश करें, या सेल्स डेस्क पर कॉल करें।',
    });
  }

  // Per-mobile, per-IP and global request rate limits (ARCHITECTURE.md §8).
  const perMobile = await bumpCounter(`otp-req:mobile:${mobile}`, 10 * 60);
  const perIp = await bumpCounter(`otp-req:ip:${ip}`, 10 * 60);
  const global = await bumpCounter('otp-req:global', 60);
  if (perMobile > 3 || perIp > 10 || global > 200) {
    throw new AppError({
      code: 'RATE_LIMITED',
      messageEn: 'Too many requests. Please wait a moment and try again.',
    });
  }

  const counterparty = await Counterparty.findOne({ mobile, deletedAt: null });
  const maskedMobile = maskMobile(mobile);
  if (!counterparty) {
    return { expiresIn: env.otpTtlSeconds, maskedMobile, accountExists: false };
  }

  const code = pickOtpCode();
  const codeHash = await bcrypt.hash(code, 10);
  const otpDoc = await AuthOtp.create({
    mobile,
    codeHash,
    expiresAt: addSeconds(new Date(), env.otpTtlSeconds),
  });

  // Real WhatsApp/SMS delivery is the notification module, M8, out of scope
  // here. Non-production builds surface the code directly so the flow can be
  // exercised end to end without it.
  const devCode = env.nodeEnv !== 'production' ? code : undefined;

  return {
    requestId: otpDoc.id as string,
    expiresIn: env.otpTtlSeconds,
    maskedMobile,
    accountExists: true,
    devCode,
  };
}

async function recordOtpFailure(otpDoc: HydratedDocument<AuthOtpDocument>): Promise<void> {
  otpDoc.attempts += 1;
  await otpDoc.save();
  const lockoutWindowSeconds = env.otpLockoutMinutes * 60;
  const failCount = await bumpCounter(`otp-fail:${otpDoc.mobile}`, lockoutWindowSeconds);
  if (failCount >= env.otpMaxAttempts) {
    await setLockout(`otp-lockout:${otpDoc.mobile}`, env.otpLockoutMinutes);
  }
}

function buildCounterpartyMeDto(counterparty: HydratedDocument<CounterpartyDocument>): MeResponse {
  const base = {
    actorType: 'counterparty' as const,
    counterpartyId: (counterparty._id as Types.ObjectId).toString(),
    mobile: counterparty.mobile,
    status: counterparty.status,
  };
  if (counterparty.kind === 'buyer') return { ...base, kind: 'buyer' } satisfies BuyerMeDto;
  if (counterparty.kind === 'seller') return { ...base, kind: 'seller' } satisfies SellerMeDto;
  return { ...base, kind: 'both' } satisfies BothMeDto;
}

async function issueCounterpartySession(
  counterparty: HydratedDocument<CounterpartyDocument>,
  deviceFingerprint: string,
  correlationId: string,
): Promise<{ accessToken: string; refreshToken: string; me: MeResponse }> {
  // QR-031 interim (ARCHITECTURE.md §5.1) — one active session per GSTIN,
  // enforced here by revoking every prior session on a fresh login.
  await AuthSession.updateMany(
    { counterpartyId: counterparty._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'new_login' } },
  );

  const refreshToken = generateRefreshToken();
  const tokenFamily = randomUUID();
  const issuedAt = new Date();
  await AuthSession.create({
    actorType: 'counterparty',
    counterpartyId: counterparty._id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    tokenFamily,
    deviceFingerprint,
    issuedAt,
    expiresAt: addSeconds(issuedAt, env.refreshTokenTtlDays * 24 * 60 * 60),
  });

  const claims: AccessTokenClaims = {
    sub: counterparty._id.toString(),
    actorType: 'counterparty',
    counterpartyId: counterparty._id.toString(),
    roles: [],
    permissions: [],
    status: counterparty.status,
  };
  const accessToken = signAccessToken(claims);

  await writeAuditLog({
    actorId: counterparty._id,
    actorType: 'counterparty',
    entity: 'counterparty',
    entityId: counterparty._id,
    field: 'login',
    correlationId,
  });

  return { accessToken, refreshToken, me: buildCounterpartyMeDto(counterparty) };
}

interface VerifyOtpResult {
  accessToken?: string;
  refreshToken?: string;
  me?: MeResponse;
  newDeviceChallengeSent?: boolean;
}

/** API-002. */
export async function verifyOtp(
  requestId: string,
  code: string,
  deviceFingerprint: string,
  correlationId: string,
): Promise<VerifyOtpResult> {
  const otpDoc = await AuthOtp.findById(requestId);
  if (!otpDoc) {
    throw new AppError({
      code: 'OTP_INVALID',
      messageEn: 'That code is not right. Check the message and enter it again.',
      messageHi: 'कोड सही नहीं है। मैसेज देखकर दोबारा डालें।',
    });
  }

  if (await isLockedOut(`otp-lockout:${otpDoc.mobile}`)) {
    throw new AppError({
      code: 'LOCKED_OUT',
      messageEn: 'Too many attempts. Try again after 30 minutes, or call the sales desk.',
      messageHi: 'बहुत बार कोशिश हुई। 30 मिनट बाद कोशिश करें, या सेल्स डेस्क पर कॉल करें।',
    });
  }

  if (otpDoc.consumedAt) {
    throw new AppError({
      code: 'OTP_INVALID',
      messageEn: 'That code is not right. Check the message and enter it again.',
      messageHi: 'कोड सही नहीं है। मैसेज देखकर दोबारा डालें।',
    });
  }

  if (otpDoc.expiresAt.getTime() < Date.now()) {
    throw new AppError({
      code: 'OTP_EXPIRED',
      messageEn: 'This code has expired. Ask for a new one.',
      messageHi: 'कोड की समय सीमा खत्म। नया कोड मंगाएँ।',
    });
  }

  const codeMatches = await bcrypt.compare(code, otpDoc.codeHash);
  if (!codeMatches) {
    await recordOtpFailure(otpDoc);
    throw new AppError({
      code: 'OTP_INVALID',
      messageEn: 'That code is not right. Check the message and enter it again.',
      messageHi: 'कोड सही नहीं है। मैसेज देखकर दोबारा डालें।',
    });
  }

  const counterparty = await Counterparty.findOne({ mobile: otpDoc.mobile, deletedAt: null });
  if (!counterparty) {
    throw new AppError({
      code: 'OTP_INVALID',
      messageEn: 'That code is not right. Check the message and enter it again.',
      messageHi: 'कोड सही नहीं है। मैसेज देखकर दोबारा डालें।',
    });
  }
  if (counterparty.status === 'blacklisted') {
    throw new AppError({
      code: 'ACCOUNT_BLACKLISTED',
      messageEn: 'This account is blocked. Call the sales desk for help.',
      messageHi: 'यह खाता ब्लॉक है। मदद के लिए सेल्स डेस्क पर कॉल करें।',
    });
  }

  // New-device step-up (CH §24.8 / API-002 NEW_DEVICE). Skipped when this
  // exact OTP was already reissued as a device challenge for this device.
  const isPreApprovedForThisDevice = otpDoc.deviceFingerprint === deviceFingerprint;
  if (!isPreApprovedForThisDevice) {
    const hasPriorSession = await AuthSession.exists({ counterpartyId: counterparty._id });
    const knownDevice = await AuthSession.exists({
      counterpartyId: counterparty._id,
      deviceFingerprint,
    });
    if (hasPriorSession && !knownDevice) {
      const freshCode = pickOtpCode();
      otpDoc.codeHash = await bcrypt.hash(freshCode, 10);
      otpDoc.expiresAt = addSeconds(new Date(), env.otpTtlSeconds);
      otpDoc.attempts = 0;
      otpDoc.consumedAt = null;
      otpDoc.deviceFingerprint = deviceFingerprint;
      await otpDoc.save();
      throw new AppError({
        code: 'NEW_DEVICE',
        messageEn: 'New device. We sent a fresh code to your registered mobile.',
        messageHi: 'नया डिवाइस। रजिस्टर्ड मोबाइल पर नया कोड भेजा गया है।',
      });
    }
  }

  otpDoc.consumedAt = new Date();
  await otpDoc.save();

  const session = await issueCounterpartySession(
    counterparty as HydratedDocument<CounterpartyDocument>,
    deviceFingerprint,
    correlationId,
  );
  return session;
}

async function loadEmployeeRoles(
  employee: EmployeeDocument,
): Promise<{ roleKeys: string[]; permissionKeys: string[] }> {
  const roles = await Role.find({ _id: { $in: employee.roleIds } });
  const roleKeys = roles.map((role) => role.key);
  const permissionKeys = [...new Set(roles.flatMap((role) => role.permissionKeys))];
  return { roleKeys, permissionKeys };
}

/** CH §24.3 — the roles that must use a second factor. */
function roleRequiresMfa(roleKeys: string[]): boolean {
  return roleKeys.some((key) => MFA_REQUIRED_ROLE_KEYS.has(key));
}

async function registerStaffFailure(employee: HydratedDocument<EmployeeDocument>): Promise<void> {
  employee.failedLoginAttempts += 1;
  if (employee.failedLoginAttempts >= env.staffLockoutAttempts) {
    // No separate STAFF_LOCKOUT_MINUTES variable exists in ARCHITECTURE.md
    // §10.1 — OTP_LOCKOUT_MINUTES is reused for the staff lockout duration
    // rather than inventing a new environment variable name.
    employee.lockedUntil = addSeconds(new Date(), env.otpLockoutMinutes * 60);
  }
  await employee.save();
}

interface StaffLoginResult {
  mfaRequired: boolean;
  mfaToken?: string;
  expiresIn?: number;
  accessToken?: string;
  refreshToken?: string;
  me?: MeResponse;
}

async function issueStaffSession(
  employee: HydratedDocument<EmployeeDocument>,
  roleKeys: string[],
  permissionKeys: string[],
  correlationId: string,
): Promise<{ accessToken: string; refreshToken: string; me: StaffMeDto }> {
  const refreshToken = generateRefreshToken();
  const issuedAt = new Date();
  await AuthSession.create({
    actorType: 'staff',
    employeeId: employee._id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    tokenFamily: randomUUID(),
    issuedAt,
    expiresAt: addSeconds(issuedAt, env.refreshTokenTtlDays * 24 * 60 * 60),
  });

  const claims: AccessTokenClaims = {
    sub: employee._id.toString(),
    actorType: 'staff',
    employeeId: employee._id.toString(),
    roles: roleKeys,
    permissions: permissionKeys,
    status: employee.active ? 'active' : 'inactive',
  };
  const accessToken = signAccessToken(claims);

  await writeAuditLog({
    actorId: employee._id,
    actorType: 'staff',
    entity: 'employee',
    entityId: employee._id,
    field: 'login',
    correlationId,
  });

  const me: StaffMeDto = {
    actorType: 'staff',
    employeeId: employee._id.toString(),
    email: employee.email,
    person: employee.person,
    roles: roleKeys,
    permissions: permissionKeys,
    mfaEnabled: employee.mfaEnabled,
  };
  return { accessToken, refreshToken, me };
}

/** API-003. */
export async function staffLogin(email: string, password: string): Promise<StaffLoginResult> {
  const employee = await Employee.findOne({ email: email.toLowerCase() });
  if (!employee) {
    throw new AppError({ code: 'INVALID_CREDENTIALS', messageEn: 'Incorrect email or password.' });
  }
  if (!employee.active) {
    throw new AppError({ code: 'ACCOUNT_NOT_ACTIVE', messageEn: 'This account is not active.' });
  }
  if (employee.lockedUntil && employee.lockedUntil.getTime() > Date.now()) {
    throw new AppError({ code: 'LOCKED_OUT', messageEn: 'Too many attempts. Try again later.' });
  }

  const passwordMatches = await bcrypt.compare(password, employee.passwordHash);
  if (!passwordMatches) {
    await registerStaffFailure(employee as HydratedDocument<EmployeeDocument>);
    throw new AppError({ code: 'INVALID_CREDENTIALS', messageEn: 'Incorrect email or password.' });
  }

  employee.failedLoginAttempts = 0;
  employee.lockedUntil = null;
  await employee.save();

  const { roleKeys, permissionKeys } = await loadEmployeeRoles(employee);
  const typedEmployee = employee as HydratedDocument<EmployeeDocument>;

  // CH §24.3 — MFA on Controller, Admin and Founder. M10: enforced by ROLE, not by the
  // `mfaEnabled` data flag — a flag left off used to let these three roles in on a password
  // alone. With no authenticator enrolled they are refused, and an Admin issues one
  // (`issueEmployeeMfa`, or the seed script for the first Admin).
  if (roleRequiresMfa(roleKeys)) {
    if (!employee.mfaSecret) {
      throw new AppError({
        code: 'MFA_ENROLMENT_REQUIRED',
        messageEn:
          'This role must sign in with an authenticator app, and none is set up yet. Ask an Admin to issue one.',
      });
    }
    return {
      mfaRequired: true,
      mfaToken: signMfaPendingToken(typedEmployee._id.toString()),
      expiresIn: MFA_PENDING_TOKEN_TTL_SECONDS_EXPORTED,
    };
  }

  const session = await issueStaffSession(typedEmployee, roleKeys, permissionKeys, randomUUID());
  return { mfaRequired: false, ...session };
}

/** API-004. */
export async function staffMfaVerify(
  mfaToken: string,
  code: string,
  correlationId: string,
): Promise<{ accessToken: string; refreshToken: string; me: StaffMeDto }> {
  let employeeId: string;
  try {
    employeeId = verifyMfaPendingToken(mfaToken).sub;
  } catch {
    throw new AppError({
      code: 'REAUTH_REQUIRED',
      messageEn: 'That MFA challenge has expired. Sign in again.',
    });
  }

  const employee = await Employee.findById(employeeId);
  if (!employee || !employee.mfaSecret) {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Sign in again.' });
  }
  if (employee.lockedUntil && employee.lockedUntil.getTime() > Date.now()) {
    throw new AppError({ code: 'LOCKED_OUT', messageEn: 'Too many attempts. Try again later.' });
  }

  const codeIsValid = await checkMfaCode(employee.mfaSecret, code);
  if (!codeIsValid) {
    await registerStaffFailure(employee as HydratedDocument<EmployeeDocument>);
    throw new AppError({ code: 'OTP_INVALID', messageEn: 'That code is not right.' });
  }

  employee.failedLoginAttempts = 0;
  employee.lockedUntil = null;
  await employee.save();

  const { roleKeys, permissionKeys } = await loadEmployeeRoles(employee);
  return issueStaffSession(
    employee as HydratedDocument<EmployeeDocument>,
    roleKeys,
    permissionKeys,
    correlationId,
  );
}

interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

/** API-005 — rotation with reuse detection. */
export async function refreshSession(presentedToken: string): Promise<RefreshResult> {
  const presentedHash = hashRefreshToken(presentedToken);
  const session = await AuthSession.findOne({ refreshTokenHash: presentedHash });

  if (!session) {
    throw new AppError({ code: 'SESSION_REPLACED', messageEn: 'Session expired. Sign in again.' });
  }

  if (session.revokedAt) {
    if (session.revokedReason === 'rotated') {
      // The token that was already exchanged for a newer one has been used
      // again — treat the whole family as compromised (ARCHITECTURE.md §5.3).
      await AuthSession.updateMany(
        { tokenFamily: session.tokenFamily },
        { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
      );
    }
    throw new AppError({ code: 'SESSION_REPLACED', messageEn: 'Session expired. Sign in again.' });
  }

  if (session.expiresAt.getTime() < Date.now()) {
    throw new AppError({ code: 'SESSION_REPLACED', messageEn: 'Session expired. Sign in again.' });
  }

  const newRefreshToken = generateRefreshToken();
  const issuedAt = new Date();
  await AuthSession.create({
    actorType: session.actorType,
    counterpartyId: session.counterpartyId,
    employeeId: session.employeeId,
    refreshTokenHash: hashRefreshToken(newRefreshToken),
    tokenFamily: session.tokenFamily,
    deviceFingerprint: session.deviceFingerprint,
    issuedAt,
    expiresAt: addSeconds(issuedAt, env.refreshTokenTtlDays * 24 * 60 * 60),
  });
  session.revokedAt = issuedAt;
  session.revokedReason = 'rotated';
  await session.save();

  let claims: AccessTokenClaims;
  if (session.actorType === 'counterparty') {
    const counterparty = await Counterparty.findById(session.counterpartyId);
    if (!counterparty) {
      throw new AppError({
        code: 'SESSION_REPLACED',
        messageEn: 'Session expired. Sign in again.',
      });
    }
    claims = {
      sub: counterparty.id as string,
      actorType: 'counterparty',
      counterpartyId: counterparty.id as string,
      roles: [],
      permissions: [],
      status: counterparty.status,
    };
  } else {
    const employee = await Employee.findById(session.employeeId);
    if (!employee) {
      throw new AppError({
        code: 'SESSION_REPLACED',
        messageEn: 'Session expired. Sign in again.',
      });
    }
    const { roleKeys, permissionKeys } = await loadEmployeeRoles(employee);
    claims = {
      sub: employee.id as string,
      actorType: 'staff',
      employeeId: employee.id as string,
      roles: roleKeys,
      permissions: permissionKeys,
      status: employee.active ? 'active' : 'inactive',
    };
  }

  return { accessToken: signAccessToken(claims), refreshToken: newRefreshToken };
}

/** API-006. */
export async function logout(
  presentedToken: string | undefined,
  allDevices: boolean,
): Promise<void> {
  if (!presentedToken) return;
  const session = await AuthSession.findOne({ refreshTokenHash: hashRefreshToken(presentedToken) });
  if (!session) return;

  if (allDevices) {
    const scope = session.counterpartyId
      ? { counterpartyId: session.counterpartyId }
      : { employeeId: session.employeeId };
    await AuthSession.updateMany(
      { ...scope, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    return;
  }

  session.revokedAt = new Date();
  session.revokedReason = 'logout';
  await session.save();
}

/** API-007. */
export async function reauth(
  employeeId: string,
  password: string,
  mfaCode: string | undefined,
): Promise<{ reauthToken: string; expiresIn: number }> {
  const employee = await Employee.findById(employeeId);
  if (!employee || !employee.active) {
    throw new AppError({ code: 'ACCOUNT_NOT_ACTIVE', messageEn: 'This account is not active.' });
  }

  const passwordMatches = await bcrypt.compare(password, employee.passwordHash);
  if (!passwordMatches) {
    throw new AppError({ code: 'INVALID_CREDENTIALS', messageEn: 'Incorrect password.' });
  }

  // M10 — by role, like sign-in: a Controller, Admin or Founder always proves the second factor.
  const { roleKeys } = await loadEmployeeRoles(employee);
  if (roleRequiresMfa(roleKeys) || employee.mfaEnabled) {
    if (!employee.mfaSecret) {
      throw new AppError({
        code: 'MFA_ENROLMENT_REQUIRED',
        messageEn: 'No authenticator is set up for this account. Ask an Admin to issue one.',
      });
    }
    const codeIsValid = mfaCode ? await checkMfaCode(employee.mfaSecret, mfaCode) : false;
    if (!codeIsValid) {
      throw new AppError({ code: 'OTP_INVALID', messageEn: 'That code is not right.' });
    }
  }

  return {
    reauthToken: signReauthToken(employeeId),
    expiresIn: REAUTH_TOKEN_TTL_SECONDS_EXPORTED,
  };
}

/** API-008. */
export async function getMe(auth: AccessTokenClaims): Promise<MeResponse> {
  if (auth.actorType === 'counterparty') {
    const counterparty = await Counterparty.findById(auth.counterpartyId);
    if (!counterparty) {
      throw new AppError({
        code: 'NOT_FOUND',
        messageEn: 'Account not found.',
        messageHi: 'खाता नहीं मिला।',
      });
    }
    return buildCounterpartyMeDto(counterparty);
  }

  const employee = await Employee.findById(auth.employeeId);
  if (!employee) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Account not found.' });
  }
  const { roleKeys, permissionKeys } = await loadEmployeeRoles(employee);
  const me: StaffMeDto = {
    actorType: 'staff',
    employeeId: employee.id as string,
    email: employee.email,
    person: employee.person,
    roles: roleKeys,
    permissions: permissionKeys,
    mfaEnabled: employee.mfaEnabled,
  };
  return me;
}
