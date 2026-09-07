import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './identity.controller.js';
import {
  logoutSchema,
  otpRequestSchema,
  otpVerifySchema,
  reauthSchema,
  staffLoginSchema,
  staffMfaVerifySchema,
} from './identity.validation.js';

export const identityRouter = Router();

// API-001
identityRouter.post('/auth/otp/request', validateBody(otpRequestSchema), controller.otpRequest);
// API-002
identityRouter.post('/auth/otp/verify', validateBody(otpVerifySchema), controller.otpVerify);
// API-003
identityRouter.post('/auth/staff/login', validateBody(staffLoginSchema), controller.staffLogin);
// API-004
identityRouter.post(
  '/auth/staff/mfa/verify',
  validateBody(staffMfaVerifySchema),
  controller.staffMfaVerify,
);
// API-005
identityRouter.post('/auth/refresh', controller.refresh);
// API-006
identityRouter.post('/auth/logout', authenticate, validateBody(logoutSchema), controller.logout);
// API-007 — staff only, ahead of any money-moving route that will require it.
identityRouter.post('/auth/reauth', authenticate, validateBody(reauthSchema), controller.reauth);
// API-008
identityRouter.get('/me', authenticate, controller.me);
