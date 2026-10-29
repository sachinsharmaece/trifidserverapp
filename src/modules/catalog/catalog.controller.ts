import type { Request, Response } from 'express';
import * as catalogService from './catalog.service.js';
import * as catalogDelete from './catalog.delete.js';
import { writeAuditLog } from '../../shared/audit.js';

/** 24 Oct — every product and pack change is audited (DEC-065). */
async function audit(
  req: Request,
  entity: 'product' | 'sku',
  entityId: string,
  field: string,
  newValue: unknown,
): Promise<void> {
  await writeAuditLog({
    actorId: req.auth!.employeeId!,
    actorType: 'staff',
    entity,
    entityId,
    field,
    newValue,
    correlationId: req.correlationId,
  });
}

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getTechnicals(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listTechnicals());
}

export async function getAllManufacturers(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listAllManufacturers());
}

export async function postManufacturer(req: Request, res: Response): Promise<void> {
  const { name, aka } = req.body as { name: string; aka?: string[] };
  ok(res, req, await catalogService.createManufacturer(name, aka), 201);
}

// Purchase-desk v2 — Admin's rename/confirm action.
export async function patchManufacturer(req: Request, res: Response): Promise<void> {
  const result = await catalogService.updateManufacturer(
    req.params.id as string,
    req.body as { name?: string; aka?: string[]; state?: 'live' },
  );
  ok(res, req, result);
}

export async function getManufacturers(req: Request, res: Response): Promise<void> {
  const { technical } = req.validatedQuery as { technical: string };
  ok(res, req, await catalogService.listManufacturersForTechnical(technical));
}

export async function getProducts(req: Request, res: Response): Promise<void> {
  const { technical, manufacturer } = req.validatedQuery as {
    technical: string;
    manufacturer?: string;
  };
  ok(res, req, await catalogService.listProducts(technical, manufacturer));
}

export async function getProductSearch(req: Request, res: Response): Promise<void> {
  const { q, limit } = req.validatedQuery as { q: string; limit: number };
  ok(res, req, await catalogService.searchProducts(q, limit));
}

export async function getSkus(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listSkusForProduct(req.params.id as string));
}

// New — the admin catalog-management screen's own unfiltered list.
export async function getAllProducts(req: Request, res: Response): Promise<void> {
  const { cursor, limit, q, deleted } = req.validatedQuery as {
    cursor?: string;
    limit?: number;
    q?: string;
    deleted?: 'true' | 'false';
  };
  const result = await catalogService.listAllProducts(cursor, limit ?? 25, q, deleted === 'true');
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor, total: result.total },
  });
}

export async function getProductById(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.getProductById(req.params.id as string));
}

export async function postProduct(req: Request, res: Response): Promise<void> {
  const result = await catalogService.createProduct(
    req.body as {
      brand: string;
      technical: string;
      manufacturerId: string;
      hsn: string;
      category?: 'seed' | 'pesticide' | 'fertilizer';
      taxPercent?: number;
      class?: 'High' | 'Medium' | 'Low';
      packs?: Array<{
        packSize: number;
        unit: 'LTR' | 'ML' | 'KG' | 'GM' | 'PC';
        unitsPerBox: number;
      }>;
    },
  );
  await audit(req, 'product', result.productId, 'create', { ...req.body, skuIds: result.skuIds });
  ok(res, req, result, 201);
}

export async function patchProduct(req: Request, res: Response): Promise<void> {
  const result = await catalogService.updateProduct(
    req.params.id as string,
    req.body as {
      brand?: string;
      technical?: string;
      manufacturerId?: string;
      hsn?: string;
      category?: 'seed' | 'pesticide' | 'fertilizer';
      taxPercent?: number;
      class?: 'High' | 'Medium' | 'Low';
      active?: boolean;
      state?: 'live';
    },
  );
  await audit(req, 'product', result.productId, 'edit', req.body);
  ok(res, req, result);
}

/** 29 Oct — soft delete (BR-370); refused while the product is in use. */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const result = await catalogDelete.deleteProduct(req.params.id as string, req.auth!.employeeId!);
  await audit(req, 'product', result.productId, 'delete', { deleted: true });
  ok(res, req, result);
}

export async function postProductRestore(req: Request, res: Response): Promise<void> {
  const result = await catalogDelete.restoreProduct(req.params.id as string);
  await audit(req, 'product', result.productId, 'restore', { deleted: false, active: false });
  ok(res, req, result);
}

export async function patchSku(req: Request, res: Response): Promise<void> {
  const result = await catalogService.updateSku(
    req.params.id as string,
    req.body as {
      packLabel?: string;
      packSize?: number;
      unitsPerBox?: number;
      unit?: 'LTR' | 'ML' | 'KG' | 'GM' | 'PC';
      active?: boolean;
      state?: 'live';
    },
  );
  await audit(req, 'sku', result.skuId, 'edit', req.body);
  ok(res, req, result);
}

export async function postSkuImport(req: Request, res: Response): Promise<void> {
  const { productId, rows } = req.body as {
    productId: string;
    rows: Array<{ packLabel: string; packSize: unknown; baseUnit: unknown; unitsPerBox: unknown }>;
  };
  const result = await catalogService.importSkus(productId, rows);
  for (const row of result.filter((r) => r.accepted && r.skuId)) {
    await audit(req, 'sku', row.skuId!, 'create', { productId, ...rows[row.index] });
  }
  ok(res, req, result, 201);
}

// 24 Oct — the Manage desk's own pack list, and "Add pack" typed as on create.
export async function getAdminSkus(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listAdminSkus(req.params.id as string));
}

export async function postProductPacks(req: Request, res: Response): Promise<void> {
  const productId = req.params.id as string;
  const { packs } = req.body as {
    packs: Array<{
      packSize: number;
      unit: 'LTR' | 'ML' | 'KG' | 'GM' | 'PC';
      unitsPerBox: number;
    }>;
  };
  const result = await catalogService.addProductPacks(productId, packs);
  for (const [index, skuId] of result.skuIds.entries()) {
    await audit(req, 'sku', skuId, 'create', { productId, ...packs[index] });
  }
  ok(res, req, result, 201);
}

export async function getTechnicalMasters(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listTechnicalMasters());
}

export async function postTechnical(req: Request, res: Response): Promise<void> {
  const { name } = req.body as { name: string };
  ok(res, req, await catalogService.createTechnical(name), 201);
}

export async function getHsnMasters(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listHsnMasters());
}

export async function postHsn(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await catalogService.createHsn(
      req.body as { code: string; description?: string; taxPercent: number },
    ),
    201,
  );
}
