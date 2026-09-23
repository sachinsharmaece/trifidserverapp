import type { ClientSession, Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { UpcomingReceipt } from '../../models/UpcomingReceipt.js';
import { Bankbook } from '../../models/Bankbook.js';
import { PaymentRun } from '../../models/PaymentRun.js';
import { Refund } from '../../models/Refund.js';
import { SellerBill } from '../../models/SellerBill.js';
import { MargBill } from '../../models/MargBill.js';
import { Inspection } from '../../models/Inspection.js';
import { Po } from '../../models/Po.js';
import { So } from '../../models/So.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { BankDetail } from '../../models/BankDetail.js';
import { AppError } from '../../shared/errors.js';
import type { Paise } from '../../shared/money.js';
import { writeAuditLog } from '../../shared/audit.js';
import { writeChainEvent } from '../chain/chain.events.js';
import {
  enqueueNotification,
  counterpartyIdForBuyer,
  paiseToRupeesText,
} from '../notification/notification.outbox.js';
import { encryptAccountNumber, decryptAccountNumber } from '../../shared/encryption.js';
import { isBankDetailPayable } from '../onboarding/onboarding.service.js';
import {
  assertBuilderIsNotReleaser,
  assertBankDetailPayable,
  assertDayCloseBalances,
  assertRefundDestinationMatchesSource,
} from '../chain/chain.guards.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// WF-06 — the receipt flow (BR-011, BR-012, INV-15)
// ---------------------------------------------------------------------------

interface CreateUpcomingReceiptInput {
  amountPaise: Paise;
  method: 'bank_message' | 'utr' | 'screenshot';
  rawText?: string;
  utr?: string;
  fileId?: string;
}

/** API-072. BR-011 — none of the three proofs is proof; any one is enough to submit. */
export async function createUpcomingReceipt(
  buyerId: string,
  input: CreateUpcomingReceiptInput,
): Promise<{ upcomingReceiptId: string }> {
  return withTransaction(async (session) => {
    const [created] = await UpcomingReceipt.create(
      [
        {
          buyerId,
          amountPaise: input.amountPaise,
          method: input.method,
          rawText: input.rawText ?? null,
          utr: input.utr ?? null,
          fileId: input.fileId ?? null,
          state: 'waiting',
        },
      ],
      { session, ordered: true },
    );
    if (!created) throw new Error('UpcomingReceipt.create returned no document.');
    // M10 — a declaration in the buyer's payment window must be visible to the
    // payment-window expiry job (BR-035): touch his unpaid SOs in this transaction,
    // so an expiry racing this claim conflicts with it and re-reads (see So.paymentTouchedAt).
    await touchUnpaidSosOfBuyer(buyerId, session);
    return { upcomingReceiptId: created.id as string };
  });
}

async function touchUnpaidSosOfBuyer(buyerId: string, session: ClientSession): Promise<void> {
  await So.updateMany(
    { buyerId, state: 'awaiting_payment' },
    { $set: { paymentTouchedAt: new Date() } },
    { session },
  );
}

/** API-080. The claim queue Sales works from before allocating (API-081). */
export async function listWaitingUpcomingReceipts(): Promise<
  Array<{ upcomingReceiptId: string; buyerId: string; amountPaise: Paise; claimedAt: Date }>
> {
  const rows = await UpcomingReceipt.find({ state: 'waiting' }).sort({ claimedAt: 1 });
  return rows.map((row) => ({
    upcomingReceiptId: row.id as string,
    buyerId: (row.buyerId as Types.ObjectId).toString(),
    amountPaise: row.amountPaise,
    claimedAt: row.claimedAt,
  }));
}

/**
 * INV-14 — no receipt is ever allocated to another party's order. Without
 * this, one buyer's money could satisfy INV-01 for someone else's SO and
 * release a PO against it.
 */
async function assertSosBelongToBuyer(soIds: string[], buyerId: Types.ObjectId): Promise<void> {
  const sos = await So.find({ _id: { $in: soIds } }).select('buyerId');
  const foundAll = sos.length === new Set(soIds).size;
  const allTheirs = sos.every((so) => (so.buyerId as Types.ObjectId).equals(buyerId));
  if (!foundAll || !allTheirs) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: "A receipt can only be allocated to the paying buyer's own orders (INV-14).",
      field: 'soIds',
    });
  }
}

/**
 * INV-01 / QR-057 (INTERIM — the real apportionment rule is still an open
 * client question). A receipt carries one amount and no per-SO split, and
 * `getPostedReceiptsPaiseForSo` counts that whole amount for every SO it
 * lists, so a receipt naming two SOs would release both POs on one SO's
 * worth of money. Until the client says how a receipt may be split, one
 * receipt covers exactly one SO. If one bank transfer must cover two SOs,
 * Sales records it as two receipt claims against the same bank credit.
 */
function assertExactlyOneSo(soIds: string[]): void {
  if (new Set(soIds).size !== 1) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn:
        'A receipt can cover exactly one order. If one bank transfer pays two orders, record it as two separate receipts (QR-057).',
      field: 'soIds',
    });
  }
}

/** API-081. BR-012 — Sales, not Accounts, knows which order the buyer meant. */
export async function allocateUpcomingReceipt(
  upcomingReceiptId: string,
  soIds: string[],
  actor: StaffActor,
): Promise<void> {
  assertExactlyOneSo(soIds); // QR-057 interim
  const receipt = await UpcomingReceipt.findById(upcomingReceiptId);
  if (!receipt) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Upcoming receipt not found.' });
  }
  if (receipt.state !== 'waiting') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This claim has already been allocated or cleared.',
    });
  }
  await assertSosBelongToBuyer(soIds, receipt.buyerId as Types.ObjectId); // INV-14
  await withTransaction(async (session) => {
    // An explicit update, not `receipt.save()`: if a concurrent allocation on the same SO
    // makes this transaction retry, a document already marked "saved" would skip the write.
    await UpcomingReceipt.updateOne(
      { _id: receipt._id },
      { $set: { soIds, pickedBy: actor.employeeId } },
      { session },
    );
    // M10 — Sales has now said this money is for these orders: the expiry job must not cancel them.
    await So.updateMany(
      { _id: { $in: soIds } },
      { $set: { paymentTouchedAt: new Date() } },
      { session },
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'upcoming_receipt',
        entityId: receipt._id as Types.ObjectId,
        field: 'soIds',
        newValue: soIds,
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}

interface PostBankCreditInput {
  utr: string;
  remitterAccountNumber: string;
  remitterIfsc: string;
}

/**
 * API-082. BR-027 — only Accounts may mark a payment verified, and every
 * mark carries a UTR and a person. Posts the credit already pointed at the
 * SOs Sales picked (BR-012) and clears the upcoming row.
 */
export async function postBankCredit(
  upcomingReceiptId: string,
  input: PostBankCreditInput,
  actor: StaffActor,
): Promise<{ bankbookId: string }> {
  const receipt = await UpcomingReceipt.findById(upcomingReceiptId);
  if (!receipt) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Upcoming receipt not found.' });
  }
  if (receipt.state !== 'waiting') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This claim is not waiting to be posted.',
    });
  }
  if (!receipt.soIds || receipt.soIds.length === 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Sales has not yet selected which SOs this claim covers (BR-012).',
    });
  }
  // QR-057 interim — also refused at posting, so a row allocated before the guard existed cannot post.
  assertExactlyOneSo(receipt.soIds.map((id) => id.toString()));

  const bankbookId = await withTransaction(async (session) => {
    const [entry] = await Bankbook.create(
      [
        {
          date: new Date(),
          kind: 'in',
          purpose: 'receipt',
          partyId: receipt.buyerId,
          partyType: 'buyer',
          amountPaise: receipt.amountPaise,
          utr: input.utr,
          narration: `Receipt for ${receipt.soIds!.length} SO(s)`,
          remitterAccountEncrypted: encryptAccountNumber(input.remitterAccountNumber),
          remitterIfsc: input.remitterIfsc,
          soIds: receipt.soIds,
          postedBy: actor.employeeId,
        },
      ],
      { session, ordered: true },
    );
    if (!entry) throw new Error('Bankbook.create returned no document.');

    // Explicit update (see `allocateUpcomingReceipt`): safe if this transaction retries.
    await UpcomingReceipt.updateOne(
      { _id: receipt._id },
      { $set: { state: 'cleared' } },
      { session },
    );
    // M10 — money is now posted against these SOs; conflicts with a concurrent expiry (BR-035).
    await So.updateMany(
      { _id: { $in: receipt.soIds } },
      { $set: { paymentTouchedAt: new Date() } },
      { session },
    );

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'bankbook',
        entityId: entry._id as Types.ObjectId,
        field: 'create',
        newValue: { amountPaise: entry.amountPaise, utr: entry.utr },
        correlationId: actor.correlationId,
      },
      session,
    );

    return (entry._id as Types.ObjectId).toString();
  });

  return { bankbookId };
}

/** INV-01's data source — every receipt posted against this SO, summed. */
export async function getPostedReceiptsPaiseForSo(
  soId: string,
  session?: ClientSession,
): Promise<Paise> {
  const rows = await Bankbook.find({ kind: 'in', purpose: 'receipt', soIds: soId }).session(
    session ?? null,
  );
  return rows.reduce((total, row) => total + row.amountPaise, 0);
}

// ---------------------------------------------------------------------------
// BR-015 — reverse and repost, Controller only
// ---------------------------------------------------------------------------

interface RepostInput {
  kind: 'in' | 'out';
  purpose: 'receipt' | 'payout' | 'refund';
  partyId: string;
  partyType: 'buyer' | 'seller';
  amountPaise: Paise;
  utr?: string;
  narration?: string;
}

/**
 * API-083. BR-015 — a wrong entry is never edited or deleted: a reversal
 * (the exact inverse direction, same amount) is posted, then the correct
 * entry is posted on top. Both happen in one transaction so the book is
 * never observed half-corrected.
 */
export async function repostBankEntry(
  originalEntryId: string,
  corrected: RepostInput,
  reason: string,
  actor: StaffActor,
): Promise<{ reversalId: string; correctedId: string }> {
  const original = await Bankbook.findById(originalEntryId);
  if (!original) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Bank book entry not found.' });
  }

  return withTransaction(async (session) => {
    const [reversal] = await Bankbook.create(
      [
        {
          date: new Date(),
          kind: original.kind === 'in' ? 'out' : 'in',
          purpose: 'reversal',
          partyId: original.partyId,
          partyType: original.partyType,
          amountPaise: original.amountPaise,
          narration: `Reversal of ${(original._id as Types.ObjectId).toString()}: ${reason}`,
          reversalOf: original._id,
          postedBy: actor.employeeId,
        },
      ],
      { session, ordered: true },
    );
    const [correctedEntry] = await Bankbook.create(
      [
        {
          date: new Date(),
          kind: corrected.kind,
          purpose: corrected.purpose,
          partyId: corrected.partyId,
          partyType: corrected.partyType,
          amountPaise: corrected.amountPaise,
          ...(corrected.utr ? { utr: corrected.utr } : {}),
          narration:
            corrected.narration ??
            `Repost, correcting ${(original._id as Types.ObjectId).toString()}`,
          postedBy: actor.employeeId,
        },
      ],
      { session, ordered: true },
    );
    if (!reversal || !correctedEntry) throw new Error('Bankbook.create returned no document.');

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'bankbook',
        entityId: original._id as Types.ObjectId,
        field: 'reverse_and_repost',
        reason,
        oldValue: { amountPaise: original.amountPaise, kind: original.kind },
        newValue: { correctedId: correctedEntry._id },
        correlationId: actor.correlationId,
      },
      session,
    );

    return {
      reversalId: (reversal._id as Types.ObjectId).toString(),
      correctedId: (correctedEntry._id as Types.ObjectId).toString(),
    };
  });
}

// ---------------------------------------------------------------------------
// BR-014 — computed ledgers, never typed. BR-013/INV-12 — buyer debtors = 0.
// ---------------------------------------------------------------------------

async function sumBankbook(
  partyId: Types.ObjectId | string,
  partyType: 'buyer' | 'seller',
  kind: 'in' | 'out',
  purposes: Array<'receipt' | 'payout' | 'refund' | 'reversal'>,
): Promise<Paise> {
  const rows = await Bankbook.find({ partyId, partyType, kind, purpose: { $in: purposes } });
  return rows.reduce((total, row) => total + row.amountPaise, 0);
}

/** BR-014 — opening + Marg bills whose value matched − every receipt posted to him. */
export async function computeBuyerLedgerPaise(buyerId: string): Promise<Paise> {
  const buyer = await Buyer.findById(buyerId);
  if (!buyer) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });

  const soIds = (await So.find({ buyerId }).select('_id')).map((doc) => doc._id);
  const matchedBills = await MargBill.find({ soId: { $in: soIds }, state: 'matched' });
  const billedPaise = matchedBills.reduce((total, bill) => total + bill.valuePaise, 0);

  const receiptsPaise = await sumBankbook(buyerId, 'buyer', 'in', ['receipt']);
  const returnedPaise = await sumBankbook(buyerId, 'buyer', 'out', ['refund', 'reversal']);
  const netReceiptsPaise = receiptsPaise - returnedPaise;

  return buyer.openingBalancePaise + billedPaise - netReceiptsPaise;
}

/** BR-014 — opening + his bills booked − payments made. Bills booked use the accepted value (Q5a). */
export async function computeSellerLedgerPaise(sellerId: string): Promise<Paise> {
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });

  const pos = await Po.find({ sellerId }).select('_id');
  const bookedBills = await SellerBill.find({ poId: { $in: pos.map((p) => p._id) }, booked: true });
  const billedPaise = bookedBills.reduce((total, bill) => total + bill.acceptedValuePaise, 0);

  const paymentsPaise = await sumBankbook(sellerId, 'seller', 'out', ['payout']);
  const reversedPaise = await sumBankbook(sellerId, 'seller', 'in', ['reversal']);
  const netPaymentsPaise = paymentsPaise - reversedPaise;

  return seller.openingBalancePaise + billedPaise - netPaymentsPaise;
}

/**
 * BR-013/INV-12 — there are no debtors, by design. A buyer's ledger should
 * never go positive (a receivable); this sums whatever positive balances
 * exist across every buyer and must always equal zero. A non-zero result
 * is an alarm, not a report.
 */
export async function totalBuyerDebtorsPaise(): Promise<Paise> {
  const buyers = await Buyer.find({}).select('_id');
  let total = 0;
  for (const buyer of buyers) {
    const ledger = await computeBuyerLedgerPaise((buyer._id as Types.ObjectId).toString());
    if (ledger > 0) total += ledger;
  }
  return total;
}

// ---------------------------------------------------------------------------
// BR-026 — buyer money is a liability until delivered. A standing figure, never stored.
// ---------------------------------------------------------------------------

// An order in one of these states has been paid in full (INV-01: a PO only
// releases on full payment) and the goods have not yet been delivered.
const PAID_UNDELIVERED_SO_STATES = [
  'po_released',
  'dispatched_leg1',
  'at_indore',
  'inspected',
  'billed_in_marg',
  'dispatched_leg2',
  'promotion_offered',
] as const;

export interface BuyerMoneyHeld {
  heldPaise: Paise;
  undeliveredOrdersPaise: Paise;
  pendingRefundsPaise: Paise;
  formula: string;
}

/**
 * "That single number is what a bad week looks like before it arrives"
 * (CH §10.16). Order value of every order paid in full and not yet delivered,
 * plus every refund raised and not yet released — money we hold that the buyer
 * has not yet received goods or a refund for.
 *
 * Every raised, unreleased refund counts — including one on a `cancelled`
 * order. Since QR-056's fix, `resolvePoolShortfall` raises a refund only for a
 * buyer who actually paid, so such a refund is real money we hold.
 */
export async function getBuyerMoneyHeld(): Promise<BuyerMoneyHeld> {
  const undelivered = await So.find({ state: { $in: [...PAID_UNDELIVERED_SO_STATES] } }).select(
    'totalPaise',
  );
  const undeliveredOrdersPaise = undelivered.reduce((sum, so) => sum + so.totalPaise, 0);

  const pendingRefunds = await Refund.find({
    state: { $in: ['payable', 'in_batch', 'held_mismatch'] },
  });
  const pendingRefundsPaise = pendingRefunds.reduce((sum, refund) => sum + refund.amountPaise, 0);

  return {
    heldPaise: undeliveredOrdersPaise + pendingRefundsPaise,
    undeliveredOrdersPaise,
    pendingRefundsPaise,
    formula:
      'Order value of every order paid in full and not yet delivered, plus every refund raised and not yet released.',
  };
}

// ---------------------------------------------------------------------------
// BR-017/INV-17 — payability, and BR-016/INV-16 — maker–checker on release
// ---------------------------------------------------------------------------

async function getLatestBankDetail(counterpartyId: Types.ObjectId | string) {
  return BankDetail.findOne({ counterpartyId }).sort({ createdAt: -1 });
}

/** API-086's `isPayable` — the three chain gates, and derived from bank_detail (IC-08/INV-17). */
export async function isPoPayable(poId: string): Promise<boolean> {
  const po = await Po.findById(poId);
  if (!po) return false;
  if (po.failed || po.paid || po.hold) return false;

  const inspection = await Inspection.findOne({ poId: po._id });
  if (!inspection || !inspection.signedAt) return false;

  const sellerBill = await SellerBill.findOne({ poId: po._id });
  if (!sellerBill || !sellerBill.booked) return false;

  const bankDetail = await getLatestBankDetail(
    (await Seller.findById(po.sellerId))?.counterpartyId ?? po.sellerId,
  );
  if (!bankDetail) return false;
  return isBankDetailPayable({
    verifiedAt: bankDetail.verifiedAt ?? null,
    effectiveFrom: bankDetail.effectiveFrom ?? null,
  });
}

/**
 * The throwing counterpart of `isPoPayable`, used at the moment a payout is
 * actually assembled into a batch (`buildPaymentRun`) — a failing-path test
 * exercises this directly rather than only the boolean read above. Reuses
 * `chain.guards.ts`'s `assertBankDetailPayable` so INV-17's refusal is the
 * same code path whether the caller is this module or a future one.
 */
export async function assertPoPayableForRelease(poId: string): Promise<void> {
  const po = await Po.findById(poId);
  if (!po || po.failed || po.paid || po.hold) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: `PO ${poId} is not in a payable state.`,
    });
  }
  const inspection = await Inspection.findOne({ poId: po._id });
  const sellerBill = await SellerBill.findOne({ poId: po._id });
  if (!inspection?.signedAt || !sellerBill?.booked) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn:
        'A seller is payable only once inspection and the seller bill are both in (BR-004).',
    });
  }
  const bankDetail = await getLatestBankDetail(
    (await Seller.findById(po.sellerId))?.counterpartyId ?? po.sellerId,
  );
  assertBankDetailPayable(
    bankDetail
      ? isBankDetailPayable({
          verifiedAt: bankDetail.verifiedAt ?? null,
          effectiveFrom: bankDetail.effectiveFrom ?? null,
        })
      : false,
  );
}

interface PaymentRunItemInput {
  kind: 'payout' | 'refund';
  refId: string; // Po id (payout) or Refund id (refund)
}

/** API-085 build. Accounts assembles the batch; every item is re-verified payable here. */
export async function buildPaymentRun(
  items: PaymentRunItemInput[],
  actor: StaffActor,
): Promise<{ paymentRunId: string }> {
  const resolvedItems: Array<{
    kind: 'payout' | 'refund';
    partyId: Types.ObjectId;
    partyType: 'buyer' | 'seller';
    amountPaise: Paise;
    refId: Types.ObjectId;
  }> = [];

  for (const item of items) {
    if (item.kind === 'payout') {
      await assertPoPayableForRelease(item.refId);
      const po = await Po.findById(item.refId);
      const bill = await SellerBill.findOne({ poId: po!._id });
      resolvedItems.push({
        kind: 'payout',
        partyId: po!.sellerId as Types.ObjectId,
        partyType: 'seller',
        amountPaise: bill!.acceptedValuePaise,
        refId: po!._id as Types.ObjectId,
      });
    } else {
      const refund = await Refund.findById(item.refId);
      if (!refund || refund.state !== 'payable') {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          messageEn: `Refund ${item.refId} is not payable.`,
        });
      }
      resolvedItems.push({
        kind: 'refund',
        partyId: refund.buyerId as Types.ObjectId,
        partyType: 'buyer',
        amountPaise: refund.amountPaise,
        refId: refund._id as Types.ObjectId,
      });
    }
  }

  const run = await PaymentRun.create({
    scheduledAt: new Date(),
    items: resolvedItems,
    builtBy: actor.employeeId,
    state: 'built',
  });

  return { paymentRunId: run.id as string };
}

interface ReleasePaymentRunInput {
  utrs?: string[];
}

/** API-085 release. INV-16 — the builder may never release, whatever the role. Requires reauth (route). */
export async function releasePaymentRun(
  paymentRunId: string,
  input: ReleasePaymentRunInput,
  actor: StaffActor,
): Promise<void> {
  const run = await PaymentRun.findById(paymentRunId);
  if (!run) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Payment run not found.' });
  }
  if (run.state !== 'built') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This run is not awaiting release.',
    });
  }
  assertBuilderIsNotReleaser(run.builtBy.toString(), actor.employeeId);

  await withTransaction(async (session) => {
    for (let i = 0; i < run.items.length; i += 1) {
      const item = run.items[i]!;
      const utr = input.utrs?.[i];

      await Bankbook.create(
        [
          {
            date: new Date(),
            kind: 'out',
            purpose: item.kind,
            partyId: item.partyId,
            partyType: item.partyType,
            amountPaise: item.amountPaise,
            ...(utr ? { utr } : {}),
            ref: (run._id as Types.ObjectId).toString(),
            postedBy: actor.employeeId,
          },
        ],
        { session, ordered: true },
      );

      if (item.kind === 'payout') {
        await Po.updateOne({ _id: item.refId }, { $set: { paid: true } }, { session });
        const po = await Po.findById(item.refId).session(session);
        await writeChainEvent(
          {
            chainId: po!.chainId,
            type: 'seller_paid',
            refCollection: 'po',
            refId: item.refId,
            actorId: actor.employeeId,
            actorType: 'staff',
            summary: `Seller payout of ₹${item.amountPaise / 100} released.`,
          },
          session,
        );
      } else {
        await Refund.updateOne(
          { _id: item.refId },
          { $set: { state: 'released', runId: run._id } },
          { session },
        );
        const refund = await Refund.findById(item.refId).session(session);
        await writeChainEvent(
          {
            chainId: refund!.chainId,
            type: 'buyer_refunded',
            refCollection: 'refund',
            refId: item.refId,
            actorId: actor.employeeId,
            actorType: 'staff',
            summary: `Refund of ₹${item.amountPaise / 100} released.`,
          },
          session,
        );
        // CH §21.8 #11 — "Refund on the run."
        await enqueueNotification(
          {
            counterpartyId: await counterpartyIdForBuyer(item.partyId, session),
            templateKey: 'refund_released',
            params: { amountRupees: paiseToRupeesText(item.amountPaise) },
            correlationId: actor.correlationId,
          },
          session,
        );
      }
    }

    run.releasedBy = actor.employeeId as unknown as Types.ObjectId;
    run.releasedAt = new Date();
    run.state = 'released';
    if (input.utrs) run.utrs = input.utrs;
    await run.save({ session });

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'payment_run',
        entityId: run._id as Types.ObjectId,
        field: 'state',
        oldValue: 'built',
        newValue: 'released',
        correlationId: actor.correlationId,
      },
      session,
    );
  });
}

/** BR-018 — a refund only ever releases to the account the money came from. */
export async function assertRefundMatchesSource(
  refundId: string,
  sourceBankbookEntryId: string,
): Promise<void> {
  const refund = await Refund.findById(refundId);
  const source = await Bankbook.findById(sourceBankbookEntryId);
  if (!refund || !source || !source.remitterAccountEncrypted) {
    throw new AppError({
      code: 'REFUND_DESTINATION_MISMATCH',
      messageEn: 'No source account on file for this refund.',
    });
  }
  const buyer = await Buyer.findById(refund.buyerId);
  const bankDetail = await getLatestBankDetail(buyer!.counterpartyId);
  if (!bankDetail) {
    throw new AppError({
      code: 'REFUND_DESTINATION_MISMATCH',
      messageEn: 'No bank detail on file.',
    });
  }
  const targetAccount = decryptAccountNumber(bankDetail.accountEncrypted);
  const sourceAccount = decryptAccountNumber(source.remitterAccountEncrypted);
  assertRefundDestinationMatchesSource(
    `${targetAccount}:${bankDetail.ifsc}`,
    `${sourceAccount}:${source.remitterIfsc ?? ''}`,
  );
}

// ---------------------------------------------------------------------------
// BR-308 — day close
// ---------------------------------------------------------------------------

/** The book's own computed closing balance — sum(in) − sum(out), all time. */
export async function computeBankbookClosingPaise(): Promise<Paise> {
  // M9 — summed by the database, not by loading the whole all-time book into memory: the
  // day close was linear in every line ever posted (1.2 s at 20,000 lines, growing daily).
  const [row] = await Bankbook.aggregate<{ closingPaise: number }>([
    {
      $group: {
        _id: null,
        closingPaise: {
          $sum: {
            $cond: [{ $eq: ['$kind', 'in'] }, '$amountPaise', { $multiply: ['$amountPaise', -1] }],
          },
        },
      },
    },
  ]);
  return row?.closingPaise ?? 0;
}

/** API — day close. BR-308: a non-zero difference is the only thing that blocks it. */
export async function runDayClose(
  statementClosingPaise: Paise,
  actor: StaffActor,
): Promise<{ closingPaise: Paise }> {
  const computed = await computeBankbookClosingPaise();
  assertDayCloseBalances(computed, statementClosingPaise);

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'day_close',
    entityId: actor.employeeId,
    field: 'closingPaise',
    newValue: computed,
    correlationId: actor.correlationId,
  });

  return { closingPaise: computed };
}

// ---------------------------------------------------------------------------
// Sales and purchase registers
// ---------------------------------------------------------------------------

export async function getSalesRegister(): Promise<
  Array<{ soId: string; soNo: string; buyerId: string; totalPaise: Paise }>
> {
  // WF-08 steps 4–5 — the SO enters the sales register the moment leg 2
  // dispatches, not only once the (M5-built) 7-day delivery window closes.
  const closedSos = await So.find({ state: { $in: ['dispatched_leg2', 'delivered', 'closed'] } })
    .sort({ updatedAt: -1 })
    .limit(200);
  return closedSos.map((so) => ({
    soId: (so._id as Types.ObjectId).toString(),
    soNo: so.soNo,
    buyerId: (so.buyerId as Types.ObjectId).toString(),
    totalPaise: so.totalPaise,
  }));
}

export async function getPurchaseRegister(): Promise<
  Array<{ poId: string; poNo: string; sellerId: string; billed: boolean }>
> {
  const bookedPos = await Po.find({ billed: true }).sort({ updatedAt: -1 }).limit(200);
  return bookedPos.map((po) => ({
    poId: (po._id as Types.ObjectId).toString(),
    poNo: po.poNo,
    sellerId: (po.sellerId as Types.ObjectId).toString(),
    billed: po.billed,
  }));
}

/**
 * New — M7, BR-023: "Seller bills are marked filed or unfiled and the
 * unfiled list is a standing Accounts queue." `SellerBill.filed` has existed
 * since M4 with nothing reading it — this is the one genuine new Accounts
 * gap this milestone's own audit found; everything else already existed.
 */
export async function getGstUnfiledQueue(): Promise<
  Array<{ sellerBillId: string; billNo: string; sellerId: string; totalPaise: Paise; date: string }>
> {
  const unfiled = await SellerBill.find({ booked: true, filed: false })
    .sort({ date: 1 })
    .limit(500);
  return unfiled.map((bill) => ({
    sellerBillId: (bill._id as Types.ObjectId).toString(),
    billNo: bill.billNo,
    sellerId: (bill.sellerId as Types.ObjectId).toString(),
    totalPaise: bill.totalPaise,
    date: bill.date.toISOString(),
  }));
}

export async function markSellerBillFiled(
  sellerBillId: string,
  actor: { employeeId: string; correlationId: string },
): Promise<{ filed: boolean }> {
  const bill = await SellerBill.findById(sellerBillId);
  if (!bill) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller bill not found.' });
  if (bill.filed) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This bill is already marked filed.',
    });
  }
  bill.filed = true;
  await bill.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'seller_bill',
    entityId: bill._id as Types.ObjectId,
    field: 'filed',
    newValue: { filed: true },
    correlationId: actor.correlationId,
  });
  return { filed: true };
}
