import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody } from '../../middleware/validate.js';
import * as controller from './orders.controller.js';
import {
  dispatchLeg1Schema,
  extensionRequestSchema,
  postComplaintSchema,
} from './orders.validation.js';

export const ordersRouter = Router();

// API-070 — 👤B. :id is a soId.
ordersRouter.get('/orders', authenticate, controller.getMyOrders);
ordersRouter.get('/orders/:id', authenticate, controller.getMyOrder);

// New — 👤S side of API-070 (the SSOT names two response shapes on one
// contract entry; kept on a distinct path here since a PO, not an SO, is
// this side's own key). :id is a poId.
ordersRouter.get('/seller/orders', authenticate, controller.getMySellerOrders);
ordersRouter.get('/seller/orders/:id', authenticate, controller.getMySellerOrder);

// API-075 — 👤S. :id is a poId. Idempotency-Key required — moves the chain stage.
ordersRouter.post(
  '/seller/orders/:id/dispatch',
  authenticate,
  requireIdempotencyKey(),
  validateBody(dispatchLeg1Schema),
  controller.postDispatch,
);
// API-076 — 👤S. :id is a poId.
ordersRouter.post(
  '/seller/orders/:id/extension-request',
  authenticate,
  validateBody(extensionRequestSchema),
  controller.postExtensionRequest,
);

// API-073 — 👤B. :id is a soId.
ordersRouter.post('/orders/:id/confirm-receipt', authenticate, controller.postConfirmReceipt);
// API-074 — 👤B. :id is a soId.
ordersRouter.post(
  '/orders/:id/complaints',
  authenticate,
  validateBody(postComplaintSchema),
  controller.postComplaint,
);
ordersRouter.get('/orders/:id/complaints', authenticate, controller.getComplaints);

// API-077 — 👤B / 👤S. :id is a soId either way.
ordersRouter.get('/orders/:id/documents', authenticate, controller.getDocuments);

// New — 👤B.
ordersRouter.get('/me/refunds', authenticate, controller.getMyRefunds);
