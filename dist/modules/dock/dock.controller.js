import * as dockService from './dock.service.js';
import { recordInspectionSchema } from './dock.validation.js';
function staffActor(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
// API-087 — 🏢 dock:inspect (Transport & Logistics).
export async function postInspection(req, res) {
    const input = recordInspectionSchema.parse(req.body);
    const result = await dockService.recordInspection(req.params.poId, input, staffActor(req));
    res.status(201).json({ data: result, meta: { correlationId: req.correlationId } });
}
// New — BR-190's Purchase half. 🏢 po:edit (Purchase).
export async function postApplyInspection(req, res) {
    const result = await dockService.applyInspection(req.params.poId, staffActor(req));
    res.status(200).json({ data: result, meta: { correlationId: req.correlationId } });
}
