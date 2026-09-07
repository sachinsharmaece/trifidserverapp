import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './admin.controller.js';
import {
  configUpdateSchema,
  createEmployeeSchema,
  listEmployeesQuerySchema,
} from './admin.validation.js';

export const adminRouter = Router();

adminRouter.use(authenticate);

// API-130
adminRouter.get('/admin/config', requirePermission(PERMISSIONS.CONFIG_READ), controller.getConfig);
adminRouter.put(
  '/admin/config/:key',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  validateBody(configUpdateSchema),
  controller.putConfig,
);

// API-132
adminRouter.post(
  '/admin/employees',
  requirePermission(PERMISSIONS.EMPLOYEE_WRITE),
  validateBody(createEmployeeSchema),
  controller.postEmployee,
);
// API-134 (new — needed by trifid-adminapp's one live screen this session;
// added to API_CONTRACT.md alongside this change).
adminRouter.get(
  '/admin/employees',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  validateQuery(listEmployeesQuerySchema),
  controller.getEmployees,
);
