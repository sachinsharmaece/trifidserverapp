import type { Request, Response } from 'express';
import * as fileService from './file.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function postFile(req: Request, res: Response): Promise<void> {
  const { mime, sizeBytes } = req.body as { mime: string; sizeBytes: number };
  const result = await fileService.createUploadTarget(mime, sizeBytes, req.auth!);
  ok(res, req, result, 201);
}

export async function getDownloadUrl(req: Request, res: Response): Promise<void> {
  const result = await fileService.createDownloadUrl(req.params.id as string);
  ok(res, req, result);
}
