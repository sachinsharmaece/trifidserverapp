import * as margService from './marg.service.js';
import { keyMargInvoiceSchema } from './marg.validation.js';
// API-088 — 🏢 marg:key. BR-033 — no override parameter exists on this input.
export async function postKeyMargInvoice(req, res) {
    const input = keyMargInvoiceSchema.parse(req.body);
    const result = await margService.keyMargInvoice(req.params.soId, input, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    res.status(201).json({ data: result, meta: { correlationId: req.correlationId } });
}
