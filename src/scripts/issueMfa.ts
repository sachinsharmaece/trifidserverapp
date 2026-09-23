import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Employee } from '../models/Employee.js';
import { issueEmployeeMfa } from '../modules/admin/admin.service.js';

/**
 * M10 — issue or re-issue a Controller/Admin/Founder's authenticator from the command
 * line, for the cut-over and for a lost phone. There is no admin-app button yet; the API
 * (`POST /admin/employees/:id/mfa`) exists and this calls the same function.
 *
 * Run: `npm run issue:mfa -- --email person@company --by admin@company`
 * `--by` must be an existing employee: the audit log records who issued it. The secret is
 * printed once, here, and nowhere else — hand it over in person.
 */
function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function issue(): Promise<void> {
  const email = argument('email');
  const by = argument('by');
  if (!email || !by) throw new Error('Usage: npm run issue:mfa -- --email <person> --by <admin>');

  await connectToDatabase(env.mongodbUri);
  const target = await Employee.findOne({ email: email.toLowerCase() });
  const issuer = await Employee.findOne({ email: by.toLowerCase(), active: true });
  if (!target) throw new Error(`No employee with email ${email}.`);
  if (!issuer) throw new Error(`No active employee with email ${by} to record as the issuer.`);

  const result = await issueEmployeeMfa(String(target._id), {
    employeeId: String(issuer._id),
    correlationId: `issue-mfa-${Date.now()}`,
  });
  console.log(`Authenticator issued for ${target.email}. They are signed out everywhere.`);
  console.log(`  Secret (enter into an authenticator app): ${result.mfaSecret}`);
  console.log(`  otpauth URL: ${result.mfaOtpauthUrl}`);
}

issue()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('Failed:', error instanceof Error ? error.message : error);
    await disconnectFromDatabase();
    process.exitCode = 1;
  });
