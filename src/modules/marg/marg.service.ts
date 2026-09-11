import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { So } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { MargBill } from '../../models/MargBill.js';
import { AppError } from '../../shared/errors.js';
import type { Paise } from '../../shared/money.js';
import { isMargValueMatched, splitTax } from '../../shared/pricing.js';
import { writeChainEvent } from '../chain/chain.events.js';
import { transitionToBilledInMarg } from '../chain/chain.service.js';
import { writeAuditLog } from '../../shared/audit.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

interface KeyMargInvoiceInput {
  margInvoiceNo: string;
  date: Date;
  valuePaise: Paise;
  ewayNo: string;
}

/**
 * API-088. BR-033 — match books the bill and advances the chain; mismatch
 * queries, books nothing anywhere, and the chain stops. **There is no
 * override parameter on this function or its route** — marg.validation.ts's
 * schema has no field that could carry one, for any role, including the
 * Controller (CH §22.9).
 */
export async function keyMargInvoice(
  soId: string,
  input: KeyMargInvoiceInput,
  actor: StaffActor,
): Promise<{ margBillId: string; state: 'matched' | 'query' }> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  if (so.state !== 'inspected') {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn:
        'This SO has not yet completed inspection — Marg billing is not available (BR-030 stage 4).',
    });
  }
  const soLine = await SoLine.findOne({ soId: so._id });
  if (!soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO line not found.' });

  const matched = isMargValueMatched(input.valuePaise, so.totalPaise); // BR-033/Q3b, ₹5 tolerance.
  const taxPortionPaise = Math.max(0, input.valuePaise - soLine.taxablePaise);
  const taxSplit = splitTax(taxPortionPaise, so.placeOfSupply as 'intra_state' | 'inter_state');

  const margBillId = await withTransaction(async (session) => {
    const [bill] = await MargBill.create(
      [
        {
          margInvoiceNo: input.margInvoiceNo,
          soId: so._id,
          placeOfSupply: so.placeOfSupply,
          taxSplit,
          valuePaise: input.valuePaise,
          ewayNo: input.ewayNo,
          state: matched ? 'matched' : 'query',
          keyedBy: actor.employeeId,
          keyedAt: input.date,
        },
      ],
      { session, ordered: true },
    );
    if (!bill) throw new Error('MargBill.create returned no document.');

    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: matched ? 'marg_matched' : 'marg_query',
        refCollection: 'marg_bill',
        refId: bill._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        summary: matched
          ? `Marg invoice ${input.margInvoiceNo} matched (₹${input.valuePaise / 100} vs SO ₹${so.totalPaise / 100}). Chain advances to dispatch.`
          : `Marg invoice ${input.margInvoiceNo} queried — ₹${Math.abs(input.valuePaise - so.totalPaise) / 100} off the SO total. No override exists; the chain stops here (BR-033).`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'marg_bill',
        entityId: bill._id as Types.ObjectId,
        field: 'state',
        newValue: matched ? 'matched' : 'query',
        correlationId: actor.correlationId,
      },
      session,
    );

    return (bill._id as Types.ObjectId).toString();
  });

  // Deliberately outside the transaction above only in the sense that it is
  // its own withTransaction call — INV-05 (a query books nothing anywhere)
  // is what matters, and on the query path this line is simply never
  // reached: no ledger, no chain-state write happens for it at all.
  if (matched) {
    await transitionToBilledInMarg(soId);
  }

  return { margBillId, state: matched ? 'matched' : 'query' };
}
