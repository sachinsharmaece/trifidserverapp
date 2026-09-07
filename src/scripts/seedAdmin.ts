import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { seedRolesAndPermissions } from '../db/seedRoles.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';

/**
 * QR-028 interim — there is no self-service staff registration. This is the
 * one-time way the very first Admin gets created; every other employee is
 * created afterwards through an authenticated `POST /admin/employees`.
 *
 * Run once: `npm run seed:admin`. Refuses to run again once any employee
 * already exists, so it can never be used to create a second "first" Admin.
 */
async function seedAdmin(): Promise<void> {
  if (!env.seedAdminEmail || !env.seedAdminPassword) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set to run this script.');
  }

  await connectToDatabase(env.mongodbUri);
  await seedRolesAndPermissions();

  const existingEmployeeCount = await Employee.countDocuments();
  if (existingEmployeeCount > 0) {
    throw new Error(
      'Refusing to run: at least one employee already exists. ' +
        'The first-Admin seed only ever runs once (QR-028).',
    );
  }

  const adminRole = await Role.findOne({ key: 'admin' });
  if (!adminRole) {
    throw new Error('Admin role was not found after seeding roles — this should not happen.');
  }

  const mfaSecret = generateSecret();
  const passwordHash = await bcrypt.hash(env.seedAdminPassword, 10);

  const admin = await Employee.create({
    person: env.seedAdminName,
    email: env.seedAdminEmail.toLowerCase(),
    passwordHash,
    roleIds: [adminRole._id],
    mfaSecret,
    mfaEnabled: true,
    active: true,
    createdBy: null,
  });

  const otpauthUrl = generateURI({
    issuer: env.staffMfaIssuer,
    label: admin.email,
    secret: mfaSecret,
  });

  // Printed once, here, and nowhere else — this is the only time the plain
  // MFA secret is ever available. Hand it to the Admin out of band.
  console.log('First Admin created.');
  console.log(`  Email: ${admin.email}`);
  console.log(`  MFA secret (enter into an authenticator app): ${mfaSecret}`);
  console.log(`  MFA otpauth URL: ${otpauthUrl}`);
}

seedAdmin()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('Seed failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
  });
