import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireReauth } from '../../middleware/requireReauth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './payment.controller.js';

export const paymentRouter = Router();

// API-072 — 👤B (any authenticated counterparty; the service trusts req.auth, never a client-supplied buyerId).
paymentRouter.post('/orders/payment-claims', authenticate, controller.postPaymentClaim);

// API-080/081 — 🏢 Sales.
paymentRouter.get(
  '/staff/upcoming-receipts',
  authenticate,
  requirePermission(PERMISSIONS.RECEIPT_READ),
  controller.getUpcomingReceipts,
);
paymentRouter.post(
  '/staff/upcoming-receipts/:id/allocate',
  authenticate,
  requirePermission(PERMISSIONS.RECEIPT_ALLOCATE),
  controller.postAllocateReceipt,
);

// API-082 — 🏢 Accounts. Idempotency-Key required — this posts money.
paymentRouter.post(
  '/staff/bank/:id/post',
  authenticate,
  requirePermission(PERMISSIONS.BANK_POST),
  requireIdempotencyKey(),
  controller.postBankCredit,
);

// API-083 — 🎛 Controller only, re-authentication required (BR-015). Idempotency-Key required.
paymentRouter.post(
  '/staff/bank/:id/repost',
  authenticate,
  requirePermission(PERMISSIONS.BANK_REPOST),
  requireReauth,
  requireIdempotencyKey(),
  controller.postRepostBankEntry,
);

// API-085/086 — 🏢 Accounts builds; 🎛 Controller releases with reauth (INV-16).
paymentRouter.get(
  '/staff/payables/:id',
  authenticate,
  requirePermission(PERMISSIONS.PAYOUT_READ),
  controller.getPoPayable,
);
paymentRouter.post(
  '/staff/payment-runs',
  authenticate,
  requirePermission(PERMISSIONS.PAYOUT_BUILD),
  requireIdempotencyKey(),
  controller.postBuildPaymentRun,
);
// Idempotency-Key required — this is the money-moving act itself.
paymentRouter.post(
  '/staff/payment-runs/:id/release',
  authenticate,
  requirePermission(PERMISSIONS.PAYOUT_RELEASE),
  requireReauth,
  requireIdempotencyKey(),
  controller.postReleasePaymentRun,
);

// New — BR-308. 🏢 Accounts.
paymentRouter.post(
  '/staff/day-close',
  authenticate,
  requirePermission(PERMISSIONS.DAY_CLOSE_RUN),
  controller.postDayClose,
);

// New — registers and ledgers. 🏢 register:read.
paymentRouter.get(
  '/staff/registers/sales',
  authenticate,
  requirePermission(PERMISSIONS.REGISTER_SALES_READ),
  controller.getSalesRegister,
);
paymentRouter.get(
  '/staff/registers/purchase',
  authenticate,
  requirePermission(PERMISSIONS.REGISTER_PURCHASE_READ),
  controller.getPurchaseRegister,
);
paymentRouter.get(
  '/staff/buyers/:buyerId/ledger',
  authenticate,
  requirePermission(PERMISSIONS.REGISTER_READ),
  controller.getBuyerLedger,
);
paymentRouter.get(
  '/staff/sellers/:sellerId/ledger',
  authenticate,
  requirePermission(PERMISSIONS.REGISTER_READ),
  controller.getSellerLedger,
);

// New — M7, BR-023. 🏢 Accounts. The one genuine new Accounts gap this
// milestone's own audit found — the field has existed since M4.
paymentRouter.get(
  '/staff/accounts/gst-unfiled',
  authenticate,
  requirePermission(PERMISSIONS.GST_UNFILED_READ),
  controller.getGstUnfiledQueue,
);
paymentRouter.post(
  '/staff/accounts/seller-bills/:sellerBillId/mark-filed',
  authenticate,
  requirePermission(PERMISSIONS.GST_MARK_FILED),
  controller.postMarkSellerBillFiled,
);
