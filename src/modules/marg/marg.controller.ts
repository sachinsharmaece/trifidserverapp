import type { Request, Response } from 'express';
import * as margService from './marg.service.js';
import { keyMargInvoiceSchema } from './marg.validation.js';

// API-088 — 🏢 marg:key. BR-033 — no override parameter exists on this input.
export async function postKeyMargInvoice(req: Request, res: Response): Promise<void> {
  const input = keyMargInvoiceSchema.parse(req.body);
  const result = await margService.keyMargInvoice(req.params.soId as string, input, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  res.status(201).json({ data: result, meta: { correlationId: req.correlationId } });
}
