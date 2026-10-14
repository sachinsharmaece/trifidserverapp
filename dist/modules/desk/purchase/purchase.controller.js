import * as purchaseService from './purchase.service.js';
import * as catalogService from '../../catalog/catalog.service.js';
import { getFunnelReport as getFunnelReportFromService } from './purchase.funnel.js';
import { draftManufacturerSchema, draftProductSchema, draftSkuSchema, nonOrderReasonSchema, sellerCatalogueEntrySchema, } from './purchase.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function staffActor(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
export async function getActiveDemandList(req, res) {
    const noSellerOnly = req.query.noSeller === 'true';
    ok(res, req, await purchaseService.getActiveDemandList({ noSellerOnly }));
}
export async function getQuoteGaps(req, res) {
    ok(res, req, await purchaseService.getQuoteGapsForAsk(req.params.askId));
}
export async function getAskSellerStates(req, res) {
    ok(res, req, await purchaseService.getAskSellerStates(req.params.askId));
}
export async function getCoverageMap(req, res) {
    ok(res, req, await purchaseService.getCoverageMap());
}
export async function getProductAnalysis(req, res) {
    ok(res, req, await purchaseService.getProductAnalysis(req.params.productId));
}
export async function getProductSellers(req, res) {
    ok(res, req, await purchaseService.getProductSellers(req.params.productId));
}
export async function getAbsorptionQueue(req, res) {
    ok(res, req, await purchaseService.getAbsorptionQueue());
}
export async function postNonOrderReason(req, res) {
    const input = nonOrderReasonSchema.parse(req.body);
    const result = await purchaseService.recordSupplyGapReason(input, {
        employeeId: req.auth.employeeId,
    });
    ok(res, req, result, 201);
}
export async function getReturnNoteAgeing(req, res) {
    ok(res, req, await purchaseService.getReturnNoteAgeing());
}
export async function getSellerRecoveryQueue(req, res) {
    ok(res, req, await purchaseService.getSellerRecoveryQueue());
}
export async function getFunnelReport(req, res) {
    ok(res, req, await getFunnelReportFromService());
}
// ---------------------------------------------------------------------------
// Purchase-desk v2.
// ---------------------------------------------------------------------------
export async function postSellerCatalogueEntry(req, res) {
    const input = sellerCatalogueEntrySchema.parse(req.body);
    const result = await purchaseService.upsertSellerCatalogueEntry(input, staffActor(req));
    ok(res, req, result, 201);
}
export async function getSellerCatalogue(req, res) {
    ok(res, req, await purchaseService.getSellerCatalogue(req.params.sellerId));
}
export async function getSellerFile(req, res) {
    ok(res, req, await purchaseService.getSellerFile(req.params.sellerId));
}
export async function getSupplyMatrixByProduct(req, res) {
    ok(res, req, await purchaseService.getSupplyMatrixByProduct());
}
export async function getSupplyMatrixBySeller(req, res) {
    ok(res, req, await purchaseService.getSupplyMatrixBySeller());
}
export async function getPilesAwaitingDecision(req, res) {
    ok(res, req, await purchaseService.getPilesAwaitingDecision());
}
export async function getDispatchChaseQueue(req, res) {
    ok(res, req, await purchaseService.getDispatchChaseQueue());
}
export async function postDispatchChase(req, res) {
    await purchaseService.logDispatchChase(req.params.poId, staffActor(req));
    ok(res, req, { logged: true }, 201);
}
export async function postAskChase(req, res) {
    const { sellerId } = req.body;
    await purchaseService.logAskChase(req.params.askId, sellerId, staffActor(req));
    ok(res, req, { logged: true }, 201);
}
export async function postPileChase(req, res) {
    await purchaseService.logPileChase(req.params.pileId, staffActor(req));
    ok(res, req, { logged: true }, 201);
}
export async function getInspectionsPendingApply(req, res) {
    ok(res, req, await purchaseService.getInspectionsPendingApply());
}
export async function getProductAnalysisAll(req, res) {
    ok(res, req, await purchaseService.getProductAnalysisAll());
}
export async function getProductFunnelAll(req, res) {
    ok(res, req, await purchaseService.getProductFunnelAll());
}
export async function getDraftMasters(req, res) {
    ok(res, req, await catalogService.listDraftMasters());
}
// Purchase-desk v2 — read access to the manufacturer/product masters for the
// desk's own near-duplicate check (client-side) and picker, without granting
// the Admin-only CATALOG_WRITE these lists otherwise sit behind.
export async function getMastersManufacturers(req, res) {
    ok(res, req, await catalogService.listAllManufacturers());
}
export async function getMastersProducts(req, res) {
    ok(res, req, await catalogService.listAllProductsLite());
}
export async function getOpenSellerDebits(req, res) {
    ok(res, req, await purchaseService.getOpenSellerDebits());
}
export async function getSupplyMatrixCallList(req, res) {
    ok(res, req, await purchaseService.getSupplyMatrixCallList(req.params.productId));
}
export async function getOnBoardNotQuotedQueue(req, res) {
    ok(res, req, await purchaseService.getOnBoardNotQuotedQueue());
}
export async function postDraftManufacturer(req, res) {
    const { name, aka } = draftManufacturerSchema.parse(req.body);
    const result = await catalogService.createManufacturerDraft(name, req.auth.employeeId, aka);
    ok(res, req, result, 201);
}
export async function postDraftProduct(req, res) {
    const input = draftProductSchema.parse(req.body);
    const result = await catalogService.createProductDraft(input, req.auth.employeeId);
    ok(res, req, result, 201);
}
export async function postDraftSku(req, res) {
    const input = draftSkuSchema.parse(req.body);
    const result = await catalogService.createSkuDraft(input, req.auth.employeeId);
    ok(res, req, result, 201);
}
