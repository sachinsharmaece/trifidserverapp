import type { Request } from 'express';
import mongoose, { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { JournalModel, ReceiptModel, UserModel, VoucherModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { VoucherSourceType } from '../../shared/enums.js';
import { conflict, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { pagingShape } from '../parties/common.js';
import { allocatedPaise } from '../payments/allocations.js';
import { postReversal } from './books.js';

/**
 * Reversing a voucher (SRS-ACC-06, Build 9). A mistake in the books is never edited away: a REVERSAL voucher
 * (RX-26-0001) mirrors the wrong one, and the books are right again. The Controller, Founder or Admin does it,
 * after re-typing the password, and says why.
 *
 * Only vouchers made BY HAND can be reversed on this screen:
 *   - a posted journal or opening balance (the journal turns REVERSED), and
 *   - a hand-added payment that is still unspent (the payment turns REVERSED and its UTR is free again).
 * Every other voucher is written by a document (a Marg bill, a dock check, a payout, a complaint, a payment entered
 * against an order). Reversing only the voucher would leave the document saying one thing and the books another,
 * so those are corrected at their document (the dock check has its own correction until the Marg bill is saved).
 * A voucher has at most one reversal, and a reversal cannot be reversed.
 */

export const reverseInput = z.object({
  reason: z.string().trim().min(1, 'Say why you are reversing it.').max(200),
});

const WHY_NOT: Partial<Record<VoucherSourceType, string>> = {
  RECEIPT: 'A payment entered against an order is part of that order, so it is not reversed here.',
  INSPECTION:
    'Goods accepted at the dock are corrected on the Dock screen, until the Marg bill is saved.',
  MARG_BILL:
    'A Marg bill is not reversed here. A complaint with a credit note corrects it for the buyer.',
  PAYOUT_LINE: 'A payout is proof of money that left the bank, so it is not reversed here.',
  COMPLAINT: "A complaint's credit note belongs to the complaint, so it is not reversed here.",
};

type VoucherDoc = InstanceType<typeof VoucherModel>;
type Reason = { ok: true } | { ok: false; reason: string };

/** Whether a voucher may be reversed on this screen, and if not, why. Pure: the caller loads what it needs. */
export function reversibility(
  voucher: Pick<VoucherDoc, 'type' | 'source'>,
  facts: {
    reversedBy: string | null;
    journalStatus?: string | undefined;
    receipt?: (Parameters<typeof allocatedPaise>[0] & { source: string }) | undefined;
  },
): Reason {
  if (voucher.type === 'REVERSAL') {
    return { ok: false, reason: 'This is a reversal. Post the entry again instead.' };
  }
  if (facts.reversedBy) return { ok: false, reason: `Already reversed by ${facts.reversedBy}.` };
  if (voucher.source.type === 'JOURNAL') {
    return facts.journalStatus === 'POSTED'
      ? { ok: true }
      : { ok: false, reason: 'This journal is not posted.' };
  }
  if (voucher.source.type === 'RECEIPT' && facts.receipt?.source === 'HAND_ADDED') {
    if (facts.receipt.status !== 'POSTED')
      return { ok: false, reason: 'This payment is not posted.' };
    return allocatedPaise(facts.receipt) > 0
      ? {
          ok: false,
          reason: 'This advance has already been used on an order, so it cannot be reversed.',
        }
      : { ok: true };
  }
  return {
    ok: false,
    reason: WHY_NOT[voucher.source.type] ?? 'This voucher is not reversed on this screen.',
  };
}

/** Reverse one voucher: the mirror voucher is posted and the document behind it is marked, in one transaction. */
export async function reverseVoucher(req: Request, voucherId: string, reason: string) {
  const userId = new Types.ObjectId(currentUserOf(req).id);
  const now = new Date();
  return mongoose.connection.transaction(async (session) => {
    const voucher = isValidObjectId(voucherId)
      ? await VoucherModel.findById(voucherId).session(session)
      : null;
    if (!voucher) throw notFound('Voucher not found.');
    const earlier = await VoucherModel.findOne({
      type: 'REVERSAL',
      'source.type': 'VOUCHER',
      'source.id': voucher._id,
    }).session(session);
    const journal =
      voucher.source.type === 'JOURNAL'
        ? await JournalModel.findById(voucher.source.id).session(session)
        : null;
    const receipt =
      voucher.source.type === 'RECEIPT'
        ? await ReceiptModel.findById(voucher.source.id).session(session)
        : null;
    const verdict = reversibility(voucher, {
      reversedBy: earlier?.number ?? null,
      journalStatus: journal?.status,
      receipt: receipt ?? undefined,
    });
    if (!verdict.ok) {
      throw conflict(verdict.reason, earlier ? 'ALREADY_REVERSED' : 'NOT_REVERSIBLE');
    }
    const reversal = await postReversal(req, voucher, { reason, userId, now }, session);
    if (journal) {
      const result = await JournalModel.updateOne(
        { _id: journal._id, status: 'POSTED', version: journal.version },
        {
          $set: {
            status: 'REVERSED',
            reversedBy: userId,
            reversedAt: now,
            reverseVoucherId: reversal._id,
            reverseNote: reason,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this entry. Reload and try again.', 'STALE_JOURNAL');
      }
    } else if (receipt) {
      const result = await ReceiptModel.updateOne(
        { _id: receipt._id, status: 'POSTED' },
        {
          $set: {
            status: 'REVERSED',
            reversedBy: userId,
            reversedAt: now,
            reverseVoucherId: reversal._id,
            reverseNote: reason,
          },
          $unset: { activeUtr: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw conflict('Someone else changed this payment. Reload and try again.', 'STALE_RECEIPT');
      }
    }
    await writeAudit(req, {
      action: 'voucher.reverse',
      entityType: 'Voucher',
      entityId: voucher.id,
      after: { number: voucher.number, reversal: reversal.number, reason },
      session,
    });
    return reversal;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The vouchers screen (day book)

export const voucherListQuery = z.object({
  ...pagingShape,
  type: z.enum(['RECEIPT', 'SALES', 'PURCHASE', 'PAYMENT', 'JOURNAL', 'REVERSAL']).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** The reversal numbers of these vouchers (by voucher id), for "Reversed by RX-26-0001". */
async function reversalNumbers(vouchers: VoucherDoc[]) {
  const reversals = vouchers.length
    ? await VoucherModel.find({
        type: 'REVERSAL',
        'source.type': 'VOUCHER',
        'source.id': { $in: vouchers.map((voucher) => voucher._id) },
      })
    : [];
  return new Map(reversals.map((reversal) => [String(reversal.source.id), reversal.number]));
}

async function voucherRows(vouchers: VoucherDoc[], includeLines: boolean) {
  const [reversedBy, journals, receipts, users] = await Promise.all([
    reversalNumbers(vouchers),
    JournalModel.find({
      _id: {
        $in: vouchers.filter((v) => v.source.type === 'JOURNAL').map((v) => v.source.id),
      },
    }),
    ReceiptModel.find({
      _id: {
        $in: vouchers.filter((v) => v.source.type === 'RECEIPT').map((v) => v.source.id),
      },
    }),
    UserModel.find({ _id: { $in: vouchers.map((v) => v.createdBy) } }, { name: 1 }),
  ]);
  return vouchers.map((voucher) => {
    const verdict = reversibility(voucher, {
      reversedBy: reversedBy.get(voucher.id) ?? null,
      journalStatus: journals.find((j) => j._id.equals(voucher.source.id))?.status,
      receipt: receipts.find((r) => r._id.equals(voucher.source.id)) ?? undefined,
    });
    return {
      id: voucher.id,
      number: voucher.number,
      type: voucher.type,
      date: voucher.date,
      narration: voucher.narration,
      totalPaise: voucher.totalPaise,
      source: { type: voucher.source.type, number: voucher.source.number },
      postedBy: users.find((user) => user._id.equals(voucher.createdBy))?.name ?? '',
      postedAt: voucher.postedAt,
      /** The REVERSAL voucher that undid this one, if any. */
      reversedBy: reversedBy.get(voucher.id) ?? null,
      canReverse: verdict.ok,
      cannotReverseBecause: verdict.ok ? null : verdict.reason,
      ...(includeLines
        ? {
            lines: voucher.lines.map((line) => ({
              ledgerName: line.ledgerName,
              drPaise: line.drPaise,
              crPaise: line.crPaise,
            })),
          }
        : {}),
    };
  });
}

export async function listVouchers(query: z.output<typeof voucherListQuery>) {
  const words = new RegExp(escapeRegex(query.q), 'i');
  const filter = {
    ...(query.type ? { type: query.type } : {}),
    ...(query.from || query.to
      ? {
          date: {
            ...(query.from ? { $gte: query.from } : {}),
            ...(query.to ? { $lte: query.to } : {}),
          },
        }
      : {}),
    ...(query.q ? { $or: [{ number: words }, { narration: words }] } : {}),
  };
  const [vouchers, total] = await Promise.all([
    VoucherModel.find(filter)
      .sort({ date: -1, number: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
    VoucherModel.countDocuments(filter),
  ]);
  return {
    vouchers: await voucherRows(vouchers, false),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function voucherDetail(id: string) {
  const voucher = isValidObjectId(id) ? await VoucherModel.findById(id) : null;
  if (!voucher) throw notFound('Voucher not found.');
  const [row] = await voucherRows([voucher], true);
  return row;
}
