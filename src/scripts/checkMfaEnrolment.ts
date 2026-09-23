import { env } from '../config/env.js';
import { MFA_REQUIRED_ROLE_KEYS } from '../config/permissions.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';

/**
 * M10 — cut-over checklist item. Lists every active Controller, Admin or Founder
 * with no authenticator enrolled. Sign-in already refuses them (CH §24.3), so this
 * cannot leave the system half-configured; it tells you who to enrol BEFORE go-live
 * so nobody arrives on the first morning locked out. Exits 1 if anyone is missing.
 *
 * Run: `npm run check:mfa`. Read-only.
 */
async function checkMfaEnrolment(): Promise<number> {
  await connectToDatabase(env.mongodbUri);
  const mfaRoles = await Role.find({ key: { $in: [...MFA_REQUIRED_ROLE_KEYS] } });
  const missing = await Employee.find({
    active: true,
    roleIds: { $in: mfaRoles.map((role) => role._id) },
    $or: [{ mfaSecret: null }, { mfaSecret: { $exists: false } }],
  }).select('email person');

  if (missing.length === 0) {
    console.log('OK — every active Controller, Admin and Founder has an authenticator enrolled.');
    return 0;
  }
  console.log(
    `${missing.length} account(s) cannot sign in until an Admin issues an authenticator:`,
  );
  for (const employee of missing) console.log(`  - ${employee.email} (${employee.person})`);
  return 1;
}

checkMfaEnrolment()
  .then(async (code) => {
    await disconnectFromDatabase();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error('Check failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 2;
  });
