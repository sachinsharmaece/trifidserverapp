import { randomUUID } from 'node:crypto';
const HEADER_NAME = 'x-correlation-id';
export function requestId(req, res, next) {
    const incoming = req.header(HEADER_NAME);
    req.correlationId = incoming && incoming.length > 0 ? incoming : randomUUID();
    res.setHeader(HEADER_NAME, req.correlationId);
    next();
}
