import * as pricingService from './pricing.service.js';
import { setMarginMatrixCellSchema } from './pricing.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getMarginMatrix(req, res) {
    const result = await pricingService.getCurrentMarginMatrix();
    ok(res, req, result);
}
export async function putMarginMatrix(req, res) {
    const input = setMarginMatrixCellSchema.parse(req.body);
    const result = await pricingService.setMarginMatrixCell(input, {
        employeeId: req.auth.employeeId,
    });
    ok(res, req, result, 201);
}
