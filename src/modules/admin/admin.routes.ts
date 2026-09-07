import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './admin.controller.js';
import {
  assignBookSchema,
  configUpdateSchema,
  createAbsenceSchema,
  createEmployeeSchema,
  listEmployeesQuerySchema,
} from './admin.validation.js';

export const adminRouter = Router();

// `authenticate` is applied per route, not via `adminRouter.use(...)` — see
// the comment in modules/file/file.routes.ts for why a blanket, path-less
// `.use()` on one router can 401 a request meant for a different, public
// router mounted afterward at the same "/api/v1" prefix.

// API-130
adminRouter.get(
  '/admin/config',
  authenticate,
  requirePermission(PERMISSIONS.CONFIG_READ),
  controller.getConfig,
);
adminRouter.put(
  '/admin/config/:key',
  authenticate,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  validateBody(configUpdateSchema),
  controller.putConfig,
);

// API-132
adminRouter.post(
  '/admin/employees',
  authenticate,
  requirePermission(PERMISSIONS.EMPLOYEE_WRITE),
  validateBody(createEmployeeSchema),
  controller.postEmployee,
);
// API-134 (new — needed by trifid-adminapp's one live screen this session;
// added to API_CONTRACT.md alongside this change).
adminRouter.get(
  '/admin/employees',
  authenticate,
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  validateQuery(listEmployeesQuerySchema),
  controller.getEmployees,
);

// New — not in the original API_CONTRACT.md. The lane board screen.
adminRouter.get(
  '/admin/lanes',
  authenticate,
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  controller.getLanes,
);

// API-133
adminRouter.post(
  '/admin/absences',
  authenticate,
  requirePermission(PERMISSIONS.EMPLOYEE_WRITE),
  validateBody(createAbsenceSchema),
  controller.postAbsence,
);

// New — not in the original API_CONTRACT.md. BR-261/BR-276 — the manual
// book-assignment action; the automatic queue-to-book trigger is M4.
adminRouter.post(
  '/admin/book-assignments',
  authenticate,
  requirePermission(PERMISSIONS.BOOK_ASSIGN),
  validateBody(assignBookSchema),
  controller.postBookAssignment,
);
