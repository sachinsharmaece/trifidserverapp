import 'dotenv/config';

// ARCHITECTURE.md §10.1 — the full variable list, copied verbatim from the SSOT.
// Never hardcode a credential; everything here is read from process.env.
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function parseSameSite(raw: string | undefined): 'lax' | 'strict' | 'none' {
  const value = (raw ?? 'lax').trim().toLowerCase();
  if (value !== 'lax' && value !== 'strict' && value !== 'none') {
    throw new Error(`Environment variable COOKIE_SAMESITE must be lax, strict or none, got "${raw}"`);
  }
  return value;
}

export const env = {
  nodeEnv: required('NODE_ENV', 'development'),
  port: optionalNumber('PORT', 4000),
  appBaseUrl: required('APP_BASE_URL', 'http://localhost:4000'),
  webBaseUrl: required('WEB_BASE_URL', 'http://localhost:3000'),
  adminBaseUrl: required('ADMIN_BASE_URL', 'http://localhost:5173'),

  mongodbUri: required('MONGODB_URI', 'mongodb://localhost:27017/trifid?replicaSet=rs0'),
  mongodbDbName: required('MONGODB_DB_NAME', 'trifid'),

  jwtAccessSecret: required('JWT_ACCESS_SECRET', 'replace-me'),
  jwtAccessTtl: required('JWT_ACCESS_TTL', '15m'),
  refreshTokenTtlDays: optionalNumber('REFRESH_TOKEN_TTL_DAYS', 30),
  cookieDomain: required('COOKIE_DOMAIN', 'localhost'),
  // 'none' is for an admin/web app on a different site than the API (e.g. a
  // *.vercel.app front end calling an onrender.com API) — a Lax cookie is
  // never sent on that cross-site fetch, so the refresh on page reload fails.
  cookieSameSite: parseSameSite(process.env.COOKIE_SAMESITE),

  otpTtlSeconds: optionalNumber('OTP_TTL_SECONDS', 300),
  otpMaxAttempts: optionalNumber('OTP_MAX_ATTEMPTS', 5),
  otpLockoutMinutes: optionalNumber('OTP_LOCKOUT_MINUTES', 30),
  // Developer addition, not in ARCHITECTURE.md §10.1 — only ever consumed
  // when NODE_ENV !== 'production' (see auth.service.ts). Lets every OTP in
  // a dev/test environment be this fixed code, so a developer testing by
  // hand doesn't have to read `devCode` back out of the API response.
  otpDevFixedCode: process.env.OTP_DEV_FIXED_CODE || undefined,
  // Same idea for staff TOTP MFA, which has no equivalent "read it back from
  // the response" convenience — a real authenticator app is otherwise the
  // only way in. Never consumed when NODE_ENV === 'production'.
  mfaDevBypassCode: process.env.MFA_DEV_BYPASS_CODE || undefined,

  // Developer addition, not in ARCHITECTURE.md §10.1. Lets a developer skip
  // Zod schema validation on request bodies/queries entirely (e.g. to hand-craft
  // malformed payloads while testing a downstream handler). Never consumed when
  // NODE_ENV === 'production' (see validate.ts) — unset/false by default.
  disableInputValidation: process.env.DISABLE_INPUT_VALIDATION === 'true',

  // 2026-10-02 — pivoting away from both features for now, reversibly: flip
  // either back to 'true' to restore it, no code changes needed. Unset/false
  // by default (off). See CHANGELOG.md's 2026-10-02 entry.
  enquiryFlowEnabled: process.env.ENQUIRY_FLOW_ENABLED === 'true',
  chainStageTrackingEnabled: process.env.CHAIN_STAGE_TRACKING_ENABLED === 'true',

  staffPasswordMinLength: optionalNumber('STAFF_PASSWORD_MIN_LENGTH', 12),
  staffLockoutAttempts: optionalNumber('STAFF_LOCKOUT_ATTEMPTS', 5),
  staffIdleTimeoutMinutes: optionalNumber('STAFF_IDLE_TIMEOUT_MINUTES', 30),
  staffMfaIssuer: required('STAFF_MFA_ISSUER', 'TriFid'),

  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'replace-me',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? 'replace-me',
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
  // Developer additions, not in ARCHITECTURE.md §10.1 — M8. The business account id
  // is what Meta's template-status endpoint is keyed on (BR-295's hourly poll); the
  // app secret signs inbound delivery-status webhooks; the verify token answers
  // Meta's one-time webhook handshake. All default to 'replace-me' so nothing is
  // ever sent or trusted until a real value is configured.
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? 'replace-me',
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET ?? 'replace-me',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'replace-me',

  fileStorageEndpoint: process.env.FILE_STORAGE_ENDPOINT ?? 'http://localhost:9000',
  fileStorageBucket: process.env.FILE_STORAGE_BUCKET ?? 'trifid-files',
  fileStorageAccessKey: process.env.FILE_STORAGE_ACCESS_KEY ?? 'replace-me',
  fileStorageSecretKey: process.env.FILE_STORAGE_SECRET_KEY ?? 'replace-me',
  fileMaxBytes: optionalNumber('FILE_MAX_BYTES', 5242880),

  // Developer addition, not in ARCHITECTURE.md §10.1 — added in M3 for
  // BankDetail.accountEncrypted (ARCHITECTURE.md §8: encrypted at rest).
  // 32 raw bytes, base64-encoded. The dev default below is for local/test
  // use only and must never be reused anywhere real.
  bankDetailEncryptionKey: required(
    'BANK_DETAIL_ENCRYPTION_KEY',
    'C5AaiVbyfQH2zjw2fCPmUnvU9MebeT13CUFfsuCka4c=',
  ),

  queueUrl: process.env.QUEUE_URL ?? '',
  workerHeartbeatSeconds: optionalNumber('WORKER_HEARTBEAT_SECONDS', 60),

  corsAllowedOrigins: required(
    'CORS_ALLOWED_ORIGINS',
    'http://localhost:3000,http://localhost:5173',
  )
    .split(',')
    .map((origin) => origin.trim()),
  rateLimitWindowSeconds: optionalNumber('RATE_LIMIT_WINDOW_SECONDS', 900),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  timezone: required('TIMEZONE', 'Asia/Kolkata'),

  // Seed script only (QR-028) — never read outside scripts/seedAdmin.ts.
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL,
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD,
  seedAdminName: process.env.SEED_ADMIN_NAME ?? 'Founding Admin',
};

export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';
