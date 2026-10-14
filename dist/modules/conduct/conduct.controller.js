import * as conductService from './conduct.service.js';
import { disagreeSchema, recordFailureSchema, advanceConductStageSchema, } from './conduct.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
// API-110 GET — 👤B.
export async function getConduct(req, res) {
    ok(res, req, await conductService.getBuyerConduct(req.auth.counterpartyId));
}
// API-110 POST disagree — 👤B.
export async function postDisagree(req, res) {
    const { reason } = disagreeSchema.parse(req.body);
    const result = await conductService.disagreeWithConduct(req.auth.counterpartyId, req.params.id, reason, req.correlationId);
    ok(res, req, result, 201);
}
// API-111 — 👤S.
export async function getScorecard(req, res) {
    ok(res, req, await conductService.getSellerScorecard(req.auth.counterpartyId));
}
// New — M6, BR-215. 🏢 Purchase/Sales.
export async function postRecordFailure(req, res) {
    const input = recordFailureSchema.parse(req.body);
    const result = await conductService.recordFailure(input, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
// New — M6, BR-213. 🏢 Purchase/Sales, maker-checker (checkerEmployeeId in the body).
export async function postAdvanceConductStage(req, res) {
    const input = advanceConductStageSchema.parse(req.body);
    const result = await conductService.advanceConductStage(req.params.id, input.toStage, input.reason, {
        employeeId: req.auth.employeeId,
        checkerEmployeeId: input.checkerEmployeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result);
}
// New — M6, QR-025. 🎛 Controller.
export async function getDisagreementQueue(req, res) {
    ok(res, req, await conductService.getGeneralDisagreementQueue());
}
// New — M6. 🏢 Purchase/Sales desk visibility into one counterparty's own ladder.
export async function getConductHistory(req, res) {
    ok(res, req, await conductService.getConductHistory(req.params.counterpartyId));
}
