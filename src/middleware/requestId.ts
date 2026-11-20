import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Accept an id from a trusted proxy/load balancer if it looks sane; otherwise make our own.
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Gives every request an id, so a user's error message can be matched to a log line. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
