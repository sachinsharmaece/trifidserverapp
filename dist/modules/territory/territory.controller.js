import { AppError } from '../../shared/errors.js';
import * as territoryService from './territory.service.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getTehsils(req, res) {
    const { district } = req.validatedQuery;
    const tehsils = await territoryService.listTehsils(district);
    ok(res, req, tehsils);
}
export async function postTehsil(req, res) {
    const { name, district, state } = req.body;
    const result = await territoryService.createTehsil(name, district, state);
    ok(res, req, result, 201);
}
export async function getMyArea(req, res) {
    const counterpartyId = req.auth?.counterpartyId;
    if (req.auth?.actorType !== 'counterparty' || !counterpartyId) {
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    }
    const result = await territoryService.getOwnArea(counterpartyId);
    ok(res, req, result);
}
