import * as adminService from './admin.service.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getConfig(req, res) {
    const entries = await adminService.listConfig();
    ok(res, req, entries);
}
export async function putConfig(req, res) {
    const { value } = req.body;
    const result = await adminService.updateConfig(req.params.key, value, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result);
}
export async function postEmployee(req, res) {
    const result = await adminService.createEmployee(req.body, { employeeId: req.auth.employeeId, correlationId: req.correlationId });
    ok(res, req, result, 201);
}
export async function postEmployeeMfa(req, res) {
    const result = await adminService.issueEmployeeMfa(req.params.id, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function getLanes(req, res) {
    ok(res, req, await adminService.listLaneBoard());
}
export async function postBookAssignment(req, res) {
    const { buyerId, ownerEmployeeId, reason } = req.body;
    const result = await adminService.assignBook({ buyerId, ownerEmployeeId, reason }, { employeeId: req.auth.employeeId, correlationId: req.correlationId });
    ok(res, req, result, 201);
}
export async function postAbsence(req, res) {
    const { employeeId, from, returnDate, coveredBy } = req.body;
    const result = await adminService.createAbsence({ employeeId, from, returnDate, coveredBy }, { employeeId: req.auth.employeeId, correlationId: req.correlationId });
    ok(res, req, result, 201);
}
export async function getEmployees(req, res) {
    const { cursor, limit } = req.validatedQuery;
    const result = await adminService.listEmployees(cursor, limit ?? 25);
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
    });
}
