import type { Request, Response } from 'express';
import * as catalogService from './catalog.service.js';

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
  const { name } = req.body as { name: string };
  ok(res, req, await catalogService.createManufacturer(name), 201);
}

// Purchase-desk v2 — Admin's rename/confirm action.
export async function patchManufacturer(req: Request, res: Response): Promise<void> {
  const result = await catalogService.updateManufacturer(
    req.params.id as string,
    req.body as { name?: string; state?: 'live' },
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

export async function getSkus(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listSkusForProduct(req.params.id as string));
}

// New — the admin catalog-management screen's own unfiltered list.
export async function getAllProducts(req: Request, res: Response): Promise<void> {
  const { cursor, limit } = req.validatedQuery as { cursor?: string; limit?: number };
  const result = await catalogService.listAllProducts(cursor, limit ?? 25);
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
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
      class?: 'A' | 'B' | 'C';
    },
  );
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
      class?: 'A' | 'B' | 'C';
      active?: boolean;
      state?: 'live';
    },
  );
  ok(res, req, result);
}

export async function patchSku(req: Request, res: Response): Promise<void> {
  const result = await catalogService.updateSku(
    req.params.id as string,
    req.body as {
      packLabel?: string;
      packSize?: number;
      unitsPerBox?: number;
      active?: boolean;
      state?: 'live';
    },
  );
  ok(res, req, result);
}

export async function postSkuImport(req: Request, res: Response): Promise<void> {
  const { productId, rows } = req.body as {
    productId: string;
    rows: Array<{ packLabel: string; packSize: unknown; baseUnit: unknown; unitsPerBox: unknown }>;
  };
  const result = await catalogService.importSkus(productId, rows);
  ok(res, req, result, 201);
}
