import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './enquiry.controller.js';
import {
  addNoteSchema,
  assigneesQuerySchema,
  convertEnquirySchema,
  createEnquirySchema,
  dropEnquirySchema,
  editEnquirySchema,
  listEnquiriesQuerySchema,
  markListedSchema,
  setFollowUpSchema,
  setOwnerSchema,
} from './enquiry.validation.js';

/**
 * Enquiry journey — `enquiry` (ENT-62, DEC-051/052).
 *
 * Reads are `chain:read`, the same permission as the chain view each enquiry
 * extends backwards from; the projection a caller receives is decided per
 * desk inside the service. Create/edit/drop serve either party (a Sales call
 * for a buyer, a Purchase call for a seller) — the route only checks the
 * caller holds ONE of the two call permissions; which one must match the
 * enquiry's own `party` is checked inside the service (`assertMayActForParty`),
 * the same pattern `requireActiveBuyer`/`requireActiveSeller` already use.
 * Converting (buyer party only) and marking listed (seller party only) are
 * each gated to their one desk. Owner, follow-up and notes are
 * `enquiry:manage`, each desk on its own half. Every trade action on an
 * enquiry (quotes, piles, orders) stays on its existing endpoint.
 */
export const enquiryRouter = Router();

const read = [authenticate, requirePermission(PERMISSIONS.CHAIN_READ)];
const buyerCall = [authenticate, requirePermission(PERMISSIONS.PROXY_BUYER_CALL)];
const sellerCall = [authenticate, requirePermission(PERMISSIONS.PROXY_SELLER_CALL)];
const eitherCall = [
  authenticate,
  requireAnyPermission(PERMISSIONS.PROXY_BUYER_CALL, PERMISSIONS.PROXY_SELLER_CALL),
];
const manage = [authenticate, requirePermission(PERMISSIONS.ENQUIRY_MANAGE)];

enquiryRouter.get(
  '/staff/enquiries',
  ...read,
  validateQuery(listEnquiriesQuerySchema),
  controller.getEnquiries,
);
// Before `/:id`, so "assignees" is never read as an enquiry id.
enquiryRouter.get(
  '/staff/enquiries/assignees',
  ...manage,
  validateQuery(assigneesQuerySchema),
  controller.getAssignees,
);
enquiryRouter.get('/staff/enquiries/:id', ...read, controller.getEnquiry);

enquiryRouter.post(
  '/staff/enquiries',
  ...eitherCall,
  validateBody(createEnquirySchema),
  controller.postEnquiry,
);
enquiryRouter.post(
  '/staff/enquiries/:id/edit',
  ...eitherCall,
  validateBody(editEnquirySchema),
  controller.postEdit,
);
enquiryRouter.post(
  '/staff/enquiries/:id/convert',
  ...buyerCall,
  validateBody(convertEnquirySchema),
  controller.postConvert,
);
enquiryRouter.post(
  '/staff/enquiries/:id/drop',
  ...eitherCall,
  validateBody(dropEnquirySchema),
  controller.postDrop,
);
enquiryRouter.post(
  '/staff/enquiries/:id/mark-listed',
  ...sellerCall,
  validateBody(markListedSchema),
  controller.postMarkListed,
);

enquiryRouter.post(
  '/staff/enquiries/:id/owner',
  ...manage,
  validateBody(setOwnerSchema),
  controller.postOwner,
);
enquiryRouter.post(
  '/staff/enquiries/:id/follow-up',
  ...manage,
  validateBody(setFollowUpSchema),
  controller.postFollowUp,
);
enquiryRouter.post(
  '/staff/enquiries/:id/notes',
  ...manage,
  validateBody(addNoteSchema),
  controller.postNote,
);
