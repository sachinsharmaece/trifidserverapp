import * as controllerService from './controller.service.js';
import { decideDisputeSchema, bulkLifelineSchema } from './controller.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getDisputeQueue(req, res) {
    ok(res, req, await controllerService.getDisputeQueue());
}
export async function postDecideDispute(req, res) {
    const input = decideDisputeSchema.parse(req.body);
    const result = await controllerService.decideDispute(req.params.complaintId, input, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function getExceptionView(req, res) {
    ok(res, req, await controllerService.getExceptionView());
}
export async function postBulkLifeline(req, res) {
    const input = bulkLifelineSchema.parse(req.body);
    const result = await controllerService.grantBulkLifeline(input.extensionHours, input.reason, {
        employeeId: req.auth.employeeId,
        checkerEmployeeId: input.checkerEmployeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
