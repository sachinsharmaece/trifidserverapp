import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// ARCHITECTURE.md §M1 — a correlation ID on every request, propagated into
// logs and, later, into worker jobs.
declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

const HEADER_NAME = 'x-correlation-id';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER_NAME);
  req.correlationId = incoming && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader(HEADER_NAME, req.correlationId);
  next();
}
