import * as adminService from './admin.service.js';
import * as team from './admin.team.js';
function actorOf(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
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
    const result = await team.createEmployee(req.body, actorOf(req));
    ok(res, req, result, 201);
}
export async function getEmployee(req, res) {
    ok(res, req, await team.getTeamMember(req.params.id));
}
export async function putEmployee(req, res) {
    const result = await team.updateEmployee(req.params.id, req.body, actorOf(req));
    ok(res, req, result);
}
export async function getDeactivationImpact(req, res) {
    ok(res, req, await team.getDeactivationImpact(req.params.id));
}
export async function postDeactivate(req, res) {
    const body = req.body;
    ok(res, req, await team.deactivateEmployee(req.params.id, body, actorOf(req)));
}
export async function postReactivate(req, res) {
    ok(res, req, await team.reactivateEmployee(req.params.id, actorOf(req)));
}
export async function postRevealPii(req, res) {
    const { field } = req.body;
    ok(res, req, await team.revealEmployeePii(req.params.id, field, actorOf(req)));
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
    const result = await adminService.assignBook({ buyerId, ownerEmployeeId, reason }, {
        employeeId: req.auth.employeeId,
        permissions: req.auth.permissions,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function postAbsence(req, res) {
    const { employeeId, from, returnDate, coveredBy } = req.body;
    const result = await adminService.createAbsence({ employeeId, from, returnDate, coveredBy }, { employeeId: req.auth.employeeId, correlationId: req.correlationId });
    ok(res, req, result, 201);
}
export async function getEmployees(req, res) {
    const { cursor, limit, status } = req.validatedQuery;
    const result = await team.listTeam({ cursor, limit: limit ?? 200, status });
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
    });
}
