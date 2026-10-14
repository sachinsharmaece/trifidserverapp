import * as catalogService from './catalog.service.js';
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
    ok(res, req, result, 201);
}
export async function patchProduct(req, res) {
    const result = await catalogService.updateProduct(req.params.id, req.body);
    ok(res, req, result);
}
export async function patchSku(req, res) {
    const result = await catalogService.updateSku(req.params.id, req.body);
    ok(res, req, result);
}
export async function postSkuImport(req, res) {
    const { productId, rows } = req.body;
    const result = await catalogService.importSkus(productId, rows);
    ok(res, req, result, 201);
}
