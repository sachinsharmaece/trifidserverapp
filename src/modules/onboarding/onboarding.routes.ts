import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './onboarding.controller.js';
import {
  bankDetailChangeSchema,
  listRegistrationsQuerySchema,
  registerBuyerSchema,
  registerSellerSchema,
  rejectRegistrationSchema,
  staffRegisterBuyerSchema,
  staffRegisterSellerSchema,
} from './onboarding.validation.js';

export const onboardingRouter = Router();

// API-010 / API-011 — 🔓, no account exists yet.
onboardingRouter.post(
  '/registrations/buyer',
  validateBody(registerBuyerSchema),
  controller.postRegisterBuyer,
);
onboardingRouter.post(
  '/registrations/seller',
  validateBody(registerSellerSchema),
  controller.postRegisterSeller,
);

// Staff-assisted enquiries — new, not in the original API_CONTRACT.md.
// Sales raises a buyer registration on a call; Purchase raises a seller
// one. Desk-boundary permissions only — the same registerBuyer/registerSeller
// as API-010/011 underneath.
onboardingRouter.post(
  '/staff/registrations/buyer',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_BUYER),
  validateBody(staffRegisterBuyerSchema),
  controller.postStaffRegisterBuyer,
);
onboardingRouter.post(
  '/staff/registrations/seller',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_SELLER),
  validateBody(staffRegisterSellerSchema),
  controller.postStaffRegisterSeller,
);

// API-012 — 🔒 any authenticated caller (ownership checked in the service).
onboardingRouter.get('/registrations/:id', authenticate, controller.getRegistration);

// API-013–015 — 🏢 staff.
onboardingRouter.get(
  '/staff/registrations',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_READ),
  validateQuery(listRegistrationsQuerySchema),
  controller.getRegistrations,
);
onboardingRouter.post(
  '/staff/registrations/:id/approve',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_APPROVE),
  controller.postApprove,
);
onboardingRouter.post(
  '/staff/registrations/:id/reject',
  authenticate,
  requirePermission(PERMISSIONS.ONBOARDING_APPROVE),
  validateBody(rejectRegistrationSchema),
  controller.postReject,
);

// New — not in the original API_CONTRACT.md, added for BR-017 (see
// CHANGELOG.md). 🏢 Accounts/Admin.
onboardingRouter.get(
  '/staff/counterparties/:id/bank-detail',
  authenticate,
  requirePermission(PERMISSIONS.BANK_DETAIL_READ),
  controller.getBankDetail,
);
onboardingRouter.post(
  '/staff/counterparties/:id/bank-detail/change',
  authenticate,
  requirePermission(PERMISSIONS.BANK_DETAIL_WRITE),
  validateBody(bankDetailChangeSchema),
  controller.postBankDetailChange,
);
onboardingRouter.post(
  '/staff/bank-details/:bankDetailId/callback',
  authenticate,
  requirePermission(PERMISSIONS.BANK_DETAIL_WRITE),
  controller.postBankDetailCallback,
);
