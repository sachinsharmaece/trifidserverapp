import { getExceptionView, type ExceptionView } from '../controller/controller.service.js';
import { getBuyerMoneyHeld, type BuyerMoneyHeld } from '../payment/payment.service.js';
import { getFunnelReport, type FunnelReport } from '../desk/purchase/purchase.funnel.js';

/**
 * The Founder overview — read-only, deliberately small (MASTER_PLAN M8).
 *
 * This module owns NO queries of its own. Each block is one call to the
 * function that already owns that number:
 *   - `exceptions`     → Controller's `getExceptionView` (the very function
 *                        behind GET /staff/controller/exceptions, M7)
 *   - `buyerMoneyHeld` → `getBuyerMoneyHeld` in payment (BR-026)
 *   - `funnel`         → Purchase's `getFunnelReport` (BR-275)
 * so the Founder and the desk that owns a figure can never disagree: there is
 * one query behind each, not two written separately.
 *
 * Not built, on purpose: a recovery-exposure figure and a per-seller debit cap.
 * That was a developer recommendation, never a client decision.
 */
export interface FounderOverview {
  asOf: string;
  buyerMoneyHeld: BuyerMoneyHeld;
  exceptions: ExceptionView;
  funnel: FunnelReport;
}

export async function getFounderOverview(): Promise<FounderOverview> {
  const [buyerMoneyHeld, exceptions, funnel] = await Promise.all([
    getBuyerMoneyHeld(),
    getExceptionView(),
    getFunnelReport(),
  ]);
  return { asOf: new Date().toISOString(), buyerMoneyHeld, exceptions, funnel };
}
