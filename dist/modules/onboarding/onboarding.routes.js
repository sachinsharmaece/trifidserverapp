import { param, requireInScope, scopeList } from '../../shared/scope.js';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './onboarding.controller.js';
import { bankDetailChangeSchema, listRegistrationsQuerySchema, registerBuyerSchema, registerSellerSchema, rejectRegistrationSchema, staffRegisterBuyerSchema, staffRegisterSellerSchema, updateBuyerSchema, updateSellerSchema, } from './onboarding.validation.js';
export const onboardingRouter = Router();
// API-010 / API-011 — 🔓, no account exists yet.
onboardingRouter.post('/registrations/buyer', validateBody(registerBuyerSchema), controller.postRegisterBuyer);
onboardingRouter.post('/registrations/seller', validateBody(registerSellerSchema), controller.postRegisterSeller);
// Staff-assisted enquiries — new, not in the original API_CONTRACT.md.
// Sales raises a buyer registration on a call; Purchase raises a seller
// one. Desk-boundary permissions only — the same registerBuyer/registerSeller
// as API-010/011 underneath.
onboardingRouter.post('/staff/registrations/buyer', authenticate, requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_BUYER), requireIdempotencyKey(), validateBody(staffRegisterBuyerSchema), controller.postStaffRegisterBuyer);
onboardingRouter.post('/staff/registrations/seller', authenticate, requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_SELLER), requireIdempotencyKey(), validateBody(staffRegisterSellerSchema), controller.postStaffRegisterSeller);
// API-012 — 🔒 any authenticated caller (ownership checked in the service).
onboardingRouter.get('/registrations/:id', authenticate, controller.getRegistration);
// API-013–015 — 🏢 staff.
onboardingRouter.get('/staff/registrations', authenticate, requirePermission(PERMISSIONS.ONBOARDING_READ), scopeList('sales', (row) => row.kind === 'seller' ? null : { counterpartyId: String(row.registrationId) }), scopeList('purchase', (row) => row.kind === 'seller' ? { counterpartyId: String(row.registrationId) } : null), validateQuery(listRegistrationsQuerySchema), controller.getRegistrations);
// Phase 3 (F1) - each side decides its own: the controller checks
// BUYER_APPROVE for a buyer, SELLER_APPROVE for a seller.
onboardingRouter.post('/staff/registrations/:id/approve', authenticate, requireAnyPermission(PERMISSIONS.BUYER_APPROVE, PERMISSIONS.SELLER_APPROVE), requireIdempotencyKey(), controller.postApprove);
onboardingRouter.post('/staff/registrations/:id/reject', authenticate, requireAnyPermission(PERMISSIONS.BUYER_APPROVE, PERMISSIONS.SELLER_APPROVE), requireIdempotencyKey(), validateBody(rejectRegistrationSchema), controller.postReject);
// Phase 3 - the buyer profile: prefill for approval (by registration id) and
// the profile's own read and Edit. Who may edit what is decided in the
// service (buyer.registration.ts).
onboardingRouter.get('/staff/registrations/:id/buyer-profile', authenticate, requireAnyPermission(PERMISSIONS.BUYER_APPROVE, PERMISSIONS.SALES_WORKLIST_READ), requireInScope('sales', param('id', 'counterparty')), controller.getRegistrationBuyerProfile);
onboardingRouter.get('/staff/buyers/:buyerId/profile', authenticate, requirePermission(PERMISSIONS.SALES_WORKLIST_READ), requireInScope('sales', param('buyerId')), controller.getBuyerProfile);
onboardingRouter.put('/staff/buyers/:buyerId/profile', authenticate, requirePermission(PERMISSIONS.SALES_WORKLIST_READ), requireInScope('sales', param('buyerId')), requireIdempotencyKey(), validateBody(updateBuyerSchema), controller.putBuyerProfile);
// Phase 4 — the seller profile, the Purchase-side twin of the buyer profile.
onboardingRouter.get('/staff/registrations/:id/seller-profile', authenticate, requireAnyPermission(PERMISSIONS.SELLER_APPROVE, PERMISSIONS.PROXY_SELLER_CALL), requireInScope('purchase', param('id', 'counterparty')), controller.getRegistrationSellerProfile);
onboardingRouter.get('/staff/sellers/:sellerId/profile', authenticate, requirePermission(PERMISSIONS.PROXY_SELLER_CALL), requireInScope('purchase', param('sellerId')), controller.getSellerProfile);
onboardingRouter.put('/staff/sellers/:sellerId/profile', authenticate, requirePermission(PERMISSIONS.PROXY_SELLER_CALL), requireInScope('purchase', param('sellerId')), requireIdempotencyKey(), validateBody(updateSellerSchema), controller.putSellerProfile);
// New — not in the original API_CONTRACT.md, added for BR-017 (see
// CHANGELOG.md). 🏢 Accounts/Admin.
onboardingRouter.get('/staff/counterparties/:id/bank-detail', authenticate, requirePermission(PERMISSIONS.BANK_DETAIL_READ), requireInScope('sales', param('id', 'counterparty')), requireInScope('purchase', param('id', 'counterparty')), controller.getBankDetail);
onboardingRouter.post('/staff/counterparties/:id/bank-detail/change', authenticate, requirePermission(PERMISSIONS.BANK_DETAIL_WRITE), validateBody(bankDetailChangeSchema), controller.postBankDetailChange);
onboardingRouter.post('/staff/bank-details/:bankDetailId/callback', authenticate, requirePermission(PERMISSIONS.BANK_DETAIL_WRITE), controller.postBankDetailCallback);
