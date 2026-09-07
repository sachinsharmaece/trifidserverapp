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

  staffPasswordMinLength: optionalNumber('STAFF_PASSWORD_MIN_LENGTH', 12),
  staffLockoutAttempts: optionalNumber('STAFF_LOCKOUT_ATTEMPTS', 5),
  staffIdleTimeoutMinutes: optionalNumber('STAFF_IDLE_TIMEOUT_MINUTES', 30),
  staffMfaIssuer: required('STAFF_MFA_ISSUER', 'TriFid'),

  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'replace-me',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? 'replace-me',
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',

  fileStorageEndpoint: process.env.FILE_STORAGE_ENDPOINT ?? 'http://localhost:9000',
  fileStorageBucket: process.env.FILE_STORAGE_BUCKET ?? 'trifid-files',
  fileStorageAccessKey: process.env.FILE_STORAGE_ACCESS_KEY ?? 'replace-me',
  fileStorageSecretKey: process.env.FILE_STORAGE_SECRET_KEY ?? 'replace-me',
  fileMaxBytes: optionalNumber('FILE_MAX_BYTES', 5242880),

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
