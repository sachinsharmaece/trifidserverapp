import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import * as controller from './catalog.controller.js';
import {
  createManufacturerSchema,
  createProductSchema,
  listAllProductsQuerySchema,
  listManufacturersQuerySchema,
  listProductsQuerySchema,
  skuImportSchema,
  updateManufacturerSchema,
  updateProductSchema,
  updateSkuSchema,
} from './catalog.validation.js';

export const catalogRouter = Router();

// `authenticate` is applied per route, not via `catalogRouter.use(...)` —
// see the comment in modules/file/file.routes.ts.

// API-020–023 — the cascading picker. Any authenticated actor (🔒).
catalogRouter.get('/catalog/technicals', authenticate, controller.getTechnicals);
catalogRouter.get(
  '/catalog/manufacturers',
  authenticate,
  validateQuery(listManufacturersQuerySchema),
  controller.getManufacturers,
);
catalogRouter.get(
  '/catalog/products',
  authenticate,
  validateQuery(listProductsQuerySchema),
  controller.getProducts,
);
catalogRouter.get('/catalog/products/:id/skus', authenticate, controller.getSkus);

// New — not in the original API_CONTRACT.md (see catalog.service.ts's
// createManufacturer for why this exists).
catalogRouter.get(
  '/admin/manufacturers',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  controller.getAllManufacturers,
);
catalogRouter.post(
  '/admin/manufacturers',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(createManufacturerSchema),
  controller.postManufacturer,
);
// Purchase-desk v2 — Admin's rename/confirm action (the draft → live PATCH).
catalogRouter.patch(
  '/admin/manufacturers/:id',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(updateManufacturerSchema),
  controller.patchManufacturer,
);

// New — the admin catalog-management screen's own unfiltered list/detail
// reads, distinct from API-022's technical-scoped picker (BR-111).
catalogRouter.get(
  '/admin/products',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateQuery(listAllProductsQuerySchema),
  controller.getAllProducts,
);
catalogRouter.get(
  '/admin/products/:id',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  controller.getProductById,
);

// API-024 / API-025 — ⚙️ catalog:write.
catalogRouter.post(
  '/admin/products',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(createProductSchema),
  controller.postProduct,
);
catalogRouter.patch(
  '/admin/products/:id',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(updateProductSchema),
  controller.patchProduct,
);
catalogRouter.post(
  '/admin/skus/import',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(skuImportSchema),
  controller.postSkuImport,
);
// New — the Manage desk's own SKU edit.
catalogRouter.patch(
  '/admin/skus/:id',
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_WRITE),
  validateBody(updateSkuSchema),
  controller.patchSku,
);
