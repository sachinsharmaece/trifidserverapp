import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { ROLE_SEED } from '../config/permissions.js';
import { Counterparty } from '../models/Counterparty.js';
import { Buyer } from '../models/Buyer.js';
import { BookAssignment } from '../models/BookAssignment.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { Tehsil } from '../models/Tehsil.js';
import { District } from '../models/District.js';
import { approveBuyer } from '../modules/onboarding/buyer.registration.js';
import type { BuyerCategory } from '../modules/onboarding/buyer.registration.js';

/**
 * 26 Oct — approve, as Admin, every pending buyer that already has what an
 * approval needs: a category, a full location (state → district → tehsil)
 * and an assigned Sales person. Buyers in the Queue, or missing anything, are
 * left pending and listed. Goes through the same `approveBuyer` the Approve
 * button uses (same checks, same audit entry), but WITHOUT the "you're
 * approved" WhatsApp — this is for test data.
 *
 *   npm run approve:pendingBuyers                 dry run: lists what would happen, writes nothing
 *   npm run approve:pendingBuyers -- --apply      approves them
 */
const ADMIN_PERMISSIONS = ROLE_SEED.find((r) => r.key === 'admin')!.permissionKeys as string[];

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);

  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  const admin = await Employee.findOne({ roleIds: adminRole?._id, active: true }).sort({ _id: 1 });
  if (!admin) throw new Error('No active Admin to approve as.');
  const caller = {
    employeeId: String(admin._id),
    permissions: ADMIN_PERMISSIONS,
    correlationId: `bulk-approve-${new Date().toISOString().slice(0, 10)}`,
  };

  const pending = await Counterparty.find({
    status: 'pending',
    kind: { $in: ['buyer', 'both'] },
  }).sort({ _id: 1 });
  const ready: Array<{ id: string; firm: string; input: Parameters<typeof approveBuyer>[1] }> = [];
  const skipped: Array<{ firm: string; why: string }> = [];

  for (const cp of pending) {
    const firm = cp.firm ?? '(no firm)';
    const buyer = await Buyer.findOne({ counterpartyId: cp._id });
    if (!buyer) {
      skipped.push({ firm, why: 'no buyer profile' });
      continue;
    }
    const assignment = await BookAssignment.findOne({ buyerId: buyer._id });
    const tehsil = buyer.tehsilId ? await Tehsil.findById(buyer.tehsilId) : null;
    const district = tehsil?.districtId ? await District.findById(tehsil.districtId) : null;
    const address = buyer.address ?? buyer.gstPpobAddress ?? '';
    const missing = [
      !assignment && 'nobody assigned (Queue)',
      !buyer.category && 'no category',
      !district && 'no full location',
      !address.trim() && 'no address',
    ].filter(Boolean);
    if (missing.length) {
      skipped.push({ firm, why: missing.join(', ') });
      continue;
    }
    ready.push({
      id: String(cp._id),
      firm,
      input: {
        category: buyer.category as BuyerCategory,
        location: {
          address,
          pincode: buyer.pincode ?? undefined,
          stateId: String(district!.stateId),
          districtId: String(district!._id),
          tehsilId: String(tehsil!._id),
        },
        assignedToEmployeeId: String(assignment!.ownerEmployeeId),
      },
    });
  }

  console.log(
    `Pending buyers: ${pending.length} — ready: ${ready.length}, left pending: ${skipped.length}`,
  );
  for (const s of skipped) console.log(`  skip  ${s.firm} — ${s.why}`);

  if (!apply) {
    console.log(
      `Dry run — nothing written. Approving as ${admin.person}; run with -- --apply to approve.`,
    );
    await disconnectFromDatabase();
    return;
  }

  let approved = 0;
  const failed: Array<{ firm: string; why: string }> = [];
  for (const r of ready) {
    try {
      await approveBuyer(r.id, r.input, caller, { notify: false });
      approved += 1;
    } catch (error) {
      failed.push({ firm: r.firm, why: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(`Approved ${approved} as ${admin.person} (no WhatsApp). Failed ${failed.length}:`);
  for (const f of failed) console.log(`  fail  ${f.firm} — ${f.why}`);
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Bulk approval failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
