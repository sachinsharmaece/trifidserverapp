import type { BuyerStage, SellerStage } from '../../shared/enums.js';

/** What people see for each stage (the funnel tabs and the deal card). */
export const BUYER_STAGE_LABELS: Record<BuyerStage, string> = {
  B1_VIEWING: 'b1 Viewing',
  B2_INQUIRY: 'b2 Inquiry',
  B3_PENDING_SELLER: 'b3 Pending seller',
  B4_SEND_CONFIRMATION: 'b4 Send confirmation',
  B5_BUYERS_CALL: "b5 Buyer's call",
  B6_ORDER_CONFIRMED: 'b6 Order confirmed',
  B7_PAID: 'b7 Paid',
  B8_BILLED: 'b8 Billing',
  B9_DISPATCH: 'b9 Dispatched',
  B10_DELIVERED: 'b10 Delivered',
  X_LEAKAGE: 'Leakage',
  X_DOCK_REJECTED: 'Dock rejected',
};

export const SELLER_STAGE_LABELS: Record<SellerStage, string> = {
  S0_DEMAND: 's0 Find a seller',
  S1_CONFIRMATION: 's1 Seller confirmation',
  S2_HOLD: 's2 Hold for payment',
  S3_PO: 's3 PO raised',
  S5_DISPATCHED: 's5 On the way',
  S5_ARRIVED: 's5 At the dock',
  S6_PAYMENT: 's6 Checked: to be paid',
  S_RELEASED: 'Released',
  S_CLOSED: 'Closed',
};

/**
 * Months from the current month (Indian time) to an expiry month 'YYYY-MM'.
 * In November 2026: '2027-05' → 6, '2026-11' → 0, '2026-10' → -1.
 */
export function monthsFromNow(expiryMonth: string, now: Date): number {
  const [year = 0, month = 0] = expiryMonth.split('-').map(Number);
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return year * 12 + month - (ist.getUTCFullYear() * 12 + ist.getUTCMonth() + 1);
}

/** The earliest allowed expiry month, 'YYYY-MM', for a floor of `floorMonths` months. */
export function earliestExpiryMonth(floorMonths: number, now: Date): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const index = ist.getUTCFullYear() * 12 + ist.getUTCMonth() + floorMonths;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
