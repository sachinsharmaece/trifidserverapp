import * as catalogService from './catalog.service.js';
import { writeAuditLog } from '../../shared/audit.js';
/** 24 Oct — every product and pack change is audited (DEC-065). */
async function audit(req, entity, entityId, field, newValue) {
    await writeAuditLog({
        actorId: req.auth.employeeId,
        actorType: 'staff',
        entity,
        entityId,
        field,
        newValue,
        correlationId: req.correlationId,
    });
}
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getTechnicals(req, res) {
    ok(res, req, await catalogService.listTechnicals());
}
export async function getAllManufacturers(req, res) {
    ok(res, req, await catalogService.listAllManufacturers());
}
export async function postManufacturer(req, res) {
    const { name, aka } = req.body;
    ok(res, req, await catalogService.createManufacturer(name, aka), 201);
}
// Purchase-desk v2 — Admin's rename/confirm action.
export async function patchManufacturer(req, res) {
    const result = await catalogService.updateManufacturer(req.params.id, req.body);
    ok(res, req, result);
}
export async function getManufacturers(req, res) {
    const { technical } = req.validatedQuery;
    ok(res, req, await catalogService.listManufacturersForTechnical(technical));
}
export async function getProducts(req, res) {
    const { technical, manufacturer } = req.validatedQuery;
    ok(res, req, await catalogService.listProducts(technical, manufacturer));
}
export async function getProductSearch(req, res) {
    const { q, limit } = req.validatedQuery;
    ok(res, req, await catalogService.searchProducts(q, limit));
}
export async function getSkus(req, res) {
    ok(res, req, await catalogService.listSkusForProduct(req.params.id));
}
// New — the admin catalog-management screen's own unfiltered list.
export async function getAllProducts(req, res) {
    const { cursor, limit } = req.validatedQuery;
    const result = await catalogService.listAllProducts(cursor, limit ?? 25);
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
    });
}
export async function getProductById(req, res) {
    ok(res, req, await catalogService.getProductById(req.params.id));
}
export async function postProduct(req, res) {
    const result = await catalogService.createProduct(req.body);
    await audit(req, 'product', result.productId, 'create', { ...req.body, skuIds: result.skuIds });
    ok(res, req, result, 201);
}
export async function patchProduct(req, res) {
    const result = await catalogService.updateProduct(req.params.id, req.body);
    await audit(req, 'product', result.productId, 'edit', req.body);
    ok(res, req, result);
}
export async function patchSku(req, res) {
    const result = await catalogService.updateSku(req.params.id, req.body);
    await audit(req, 'sku', result.skuId, 'edit', req.body);
    ok(res, req, result);
}
export async function postSkuImport(req, res) {
    const { productId, rows } = req.body;
    const result = await catalogService.importSkus(productId, rows);
    for (const row of result.filter((r) => r.accepted && r.skuId)) {
        await audit(req, 'sku', row.skuId, 'create', { productId, ...rows[row.index] });
    }
    ok(res, req, result, 201);
}
// 24 Oct — the Manage desk's own pack list, and "Add pack" typed as on create.
export async function getAdminSkus(req, res) {
    ok(res, req, await catalogService.listAdminSkus(req.params.id));
}
export async function postProductPacks(req, res) {
    const productId = req.params.id;
    const { packs } = req.body;
    const result = await catalogService.addProductPacks(productId, packs);
    for (const [index, skuId] of result.skuIds.entries()) {
        await audit(req, 'sku', skuId, 'create', { productId, ...packs[index] });
    }
    ok(res, req, result, 201);
}
export async function getTechnicalMasters(req, res) {
    ok(res, req, await catalogService.listTechnicalMasters());
}
export async function postTechnical(req, res) {
    const { name } = req.body;
    ok(res, req, await catalogService.createTechnical(name), 201);
}
export async function getHsnMasters(req, res) {
    ok(res, req, await catalogService.listHsnMasters());
}
export async function postHsn(req, res) {
    ok(res, req, await catalogService.createHsn(req.body), 201);
}
