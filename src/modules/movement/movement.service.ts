import type { Types } from 'mongoose';
import { So } from '../../models/So.js';
import { Po } from '../../models/Po.js';
import { Movement } from '../../models/Movement.js';
import { MargBill } from '../../models/MargBill.js';
import { AppError } from '../../shared/errors.js';
import type { Paise } from '../../shared/money.js';
import { assertMargMatchedBeforeDispatch } from '../chain/chain.guards.js';
import { transitionToDispatchedLeg1, transitionToDispatchedLeg2 } from '../chain/chain.service.js';
import { writeAuditLog } from '../../shared/audit.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

interface RecordMovementInput {
  leg: 1 | 2;
  mode: 'transport' | 'bus';
  transporter?: string;
  lr?: string;
  busNo?: string;
  driver?: string;
  driverMobile?: string;
  photoRef?: string;
  freightTerms: 'prepaid' | 'to_pay';
  freightAmountPaise: Paise;
}

/**
 * API-089. BR-176 — two dispatch modes, both legs; LR mandatory on
 * transport mode (checked in movement.validation.ts). Leg 1 requires the PO
 * to have released (BR-030 stage 3 → 4); leg 2 requires a **matched** Marg
 * bill and nothing else (INV-04/BR-033) — the one guard this milestone's
 * whole Marg module exists to protect.
 */
export async function recordMovement(
  chainId: string,
  input: RecordMovementInput,
  actor: StaffActor,
): Promise<{ movementId: string }> {
  const so = await So.findOne({ chainId });
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'No SO found on this chain.' });
  const po = await Po.findOne({ chainId });
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'No PO found on this chain.' });

  if (input.leg === 1) {
    if (so.state !== 'po_released') {
      throw new AppError({
        code: 'CHAIN_STAGE_GUARD_FAILED',
        messageEn: 'Leg 1 can only be recorded once the PO has released (BR-030 stage 3).',
      });
    }
  } else {
    const margBill = await MargBill.findOne({ soId: so._id, state: 'matched' });
    assertMargMatchedBeforeDispatch(margBill ? 'matched' : null); // INV-04/BR-033.
  }

  const movement = await Movement.create({
    chainId,
    leg: input.leg,
    mode: input.mode,
    transporter: input.transporter ?? null,
    lr: input.lr ?? null,
    busNo: input.busNo ?? null,
    driver: input.driver ?? null,
    driverMobile: input.driverMobile ?? null,
    photoRef: input.photoRef ?? null,
    freightTerms: input.freightTerms,
    freightAmountPaise: input.freightAmountPaise,
    recordedBy: actor.employeeId,
  });

  if (input.leg === 1) {
    await transitionToDispatchedLeg1(
      (so._id as Types.ObjectId).toString(),
      (po._id as Types.ObjectId).toString(),
    );
  } else {
    await transitionToDispatchedLeg2(
      (so._id as Types.ObjectId).toString(),
      (po._id as Types.ObjectId).toString(),
    );
  }

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'movement',
    entityId: movement._id as Types.ObjectId,
    field: 'create',
    newValue: { leg: input.leg, mode: input.mode },
    correlationId: actor.correlationId,
  });

  return { movementId: movement.id as string };
}
