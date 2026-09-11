import { AppError } from '../../shared/errors.js';
import type { Paise } from '../../shared/money.js';

/**
 * BR-030's guards, each as a small named function so it can be exercised
 * directly by a failing-path test (CH §25.6) as well as called from
 * chain.service.ts. Plain predicates over already-loaded values — the
 * service layer is responsible for fetching those values; these functions
 * only decide, and throw.
 */

/** INV-01 — no PO before the SO is paid in full. No partial PO on partial payment. */
export function assertPaymentSatisfied(postedReceiptsPaise: Paise, soTotalPaise: Paise): void {
  if (postedReceiptsPaise < soTotalPaise) {
    throw new AppError({
      code: 'SO_NOT_PAID_IN_FULL',
      messageEn: `Posted receipts (₹${postedReceiptsPaise / 100}) have not reached the SO total (₹${soTotalPaise / 100}).`,
    });
  }
}

/** Q4 — no speculative stock: exactly one PO per paid SO, never more. */
export function assertNoExistingPo(alreadyExists: boolean): void {
  if (alreadyExists) {
    throw new AppError({
      code: 'PO_ALREADY_EXISTS',
      messageEn: 'A purchase order already exists against this sales order.',
    });
  }
}

/** INV-07 — a PO's rate never exceeds the SO's rate on the same chain. */
export function assertPoRateNeverExceedsSoRate(poSellerNetPaise: Paise, soRatePaise: Paise): void {
  if (poSellerNetPaise > soRatePaise) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: `The PO rate (₹${poSellerNetPaise / 100}) may never exceed the SO rate (₹${soRatePaise / 100}) on the same chain (INV-07).`,
    });
  }
}

/** INV-08 — quantities on a paired SO and PO match. */
export function assertQuantitiesMatch(soBoxes: number, poBoxes: number): void {
  if (soBoxes !== poBoxes) {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn: `SO quantity (${soBoxes} boxes) and PO quantity (${poBoxes} boxes) must match (INV-08).`,
    });
  }
}

/** INV-04/BR-033 — nothing dispatches without a matched Marg invoice. No override, no role. */
export function assertMargMatchedBeforeDispatch(margBillState: 'matched' | 'query' | null): void {
  if (margBillState !== 'matched') {
    throw new AppError({
      code: 'CHAIN_STAGE_GUARD_FAILED',
      messageEn:
        'Leg 2 cannot dispatch without a matched Marg invoice. A query blocks the chain with no override, for any role (BR-033).',
    });
  }
}

/** INV-16 — a payment batch's builder may never release it, whatever the role. */
export function assertBuilderIsNotReleaser(builtBy: string, releasedBy: string): void {
  if (builtBy === releasedBy) {
    throw new AppError({
      code: 'BUILDER_CANNOT_RELEASE',
      messageEn: 'The person who built this batch may not also release it.',
    });
  }
}

/** INV-17 — nothing payable to a counterparty with an unverified or cooling bank change. */
export function assertBankDetailPayable(isPayable: boolean): void {
  if (!isPayable) {
    throw new AppError({
      code: 'BANK_CHANGE_PENDING',
      messageEn: 'This counterparty has no verified, non-cooling bank detail on file.',
    });
  }
}

/** BR-036 — a document is never editable after billing. */
export function assertNotAlreadyBilled(billed: boolean): void {
  if (billed) {
    throw new AppError({
      code: 'DOCUMENT_ALREADY_BILLED',
      messageEn: 'This document has already been billed and can no longer be edited (BR-036).',
    });
  }
}

/** Q6 — the SO can only be reduced before a Marg bill exists against it. */
export function assertNoMargBillYet(margBillExists: boolean): void {
  if (margBillExists) {
    throw new AppError({
      code: 'DOCUMENT_ALREADY_BILLED',
      messageEn: 'This SO already has a Marg bill; the quantity can no longer be reduced.',
    });
  }
}

/** BR-184 — an inspection result is immutable once submitted. */
export function assertInspectionNotYetSubmitted(alreadySubmitted: boolean): void {
  if (alreadySubmitted) {
    throw new AppError({
      code: 'INSPECTION_IMMUTABLE',
      messageEn: 'This inspection has already been submitted and cannot be changed.',
    });
  }
}

/** BR-018 — a refund is never auto-sent to an account nominated mid-stream. */
export function assertRefundDestinationMatchesSource(
  targetAccountFingerprint: string,
  sourceAccountFingerprint: string,
): void {
  if (targetAccountFingerprint !== sourceAccountFingerprint) {
    throw new AppError({
      code: 'REFUND_DESTINATION_MISMATCH',
      messageEn:
        'The refund destination does not match the account the money came from. Held for staff review.',
    });
  }
}

/** BR-308 — day close is blocked only by a non-zero difference, nothing else. */
export function assertDayCloseBalances(
  computedClosingPaise: Paise,
  statementClosingPaise: Paise,
): void {
  if (computedClosingPaise !== statementClosingPaise) {
    throw new AppError({
      code: 'DAY_CLOSE_OUT_OF_BALANCE',
      messageEn: `Computed closing (₹${computedClosingPaise / 100}) does not match the statement closing (₹${statementClosingPaise / 100}).`,
    });
  }
}
