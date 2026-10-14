import * as logisticsService from './logistics.service.js';
import { createTransporterSchema, createConsolidationSchema } from './logistics.validation.js';
import { assertValidObjectId } from '../../shared/objectId.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function actorOf(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
export async function postTransporter(req, res) {
    const input = createTransporterSchema.parse(req.body);
    ok(res, req, await logisticsService.createTransporter(input, actorOf(req)), 201);
}
export async function getTransporters(req, res) {
    const activeOnly = req.query.all !== 'true';
    ok(res, req, await logisticsService.listTransporters(activeOnly));
}
export async function postGoodsIn(req, res) {
    const poId = req.params.poId;
    assertValidObjectId(poId, 'poId'); // B-57 — was an uncaught CastError (bare 500).
    ok(res, req, await logisticsService.recordGoodsIn(poId, actorOf(req)), 201);
}
export async function getHubPosition(req, res) {
    ok(res, req, await logisticsService.getHubPosition());
}
export async function postConsolidation(req, res) {
    const input = createConsolidationSchema.parse(req.body);
    ok(res, req, await logisticsService.createConsolidation(input.movementIds, actorOf(req)), 201);
}
export async function postArrangeReturnCollection(req, res) {
    ok(res, req, await logisticsService.arrangeReturnCollection(req.params.returnNoteId, actorOf(req)), 201);
}
export async function postCloseReturnNote(req, res) {
    ok(res, req, await logisticsService.closeReturnNote(req.params.returnNoteId, actorOf(req)), 201);
}
export async function getDashboard(req, res) {
    ok(res, req, await logisticsService.getDashboard());
}
